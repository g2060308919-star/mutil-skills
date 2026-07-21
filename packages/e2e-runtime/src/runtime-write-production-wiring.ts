import {
  createAuthenticatedRpcHttpTransport,
  createAuthorityMaintenanceRpcClient,
  type AuthorityMaintenanceRpcClient,
} from '@mutil-skills/e2e-authority'
import {
  ArtifactSchemaRegistry,
  canonicalizeJson,
  digestArtifactContent,
  digestText,
  E2EError,
  type CapabilityReservation,
} from '@mutil-skills/e2e-contracts'
import { LocalArtifactStore } from '@mutil-skills/e2e-engine'
import { constants } from 'node:fs'
import type { Stats } from 'node:fs'
import { lstat, open, realpath, rename, rm } from 'node:fs/promises'
import { connect } from 'node:net'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import {
  openRuntimeArtifactStoreAuthority,
  runtimeApprovalExecutionBinding,
  startRuntimeAuthorityHost,
  type RuntimeAuthorityHost,
} from './authority-host.js'
import { inspectRuntimeInstallation, type RuntimeInstallation } from './runtime-discovery.js'
import { runtimeLayout } from './runtime-layout.js'
import {
  RuntimeOwnedResourceRegistry,
  type RuntimeOwnedResourceOperations,
  type RuntimeOwnedResourceRecord,
} from './runtime-owned-resource-registry.js'
import { RuntimeRecoveryCoordinator } from './runtime-recovery.js'
import type { RuntimeRunSnapshot, RuntimeRunStore } from './run-store.js'
import { projectRuntimeWriteSnapshot } from './runtime-write-projector.js'
import {
  authorizeRuntimeWriteProduction,
  type RuntimeWriteProductionCapability,
} from './runtime-write-production.js'

const DIGEST = /^sha256:[a-f0-9]{64}$/

export interface OpenRuntimeWriteProductionResult {
  capability: RuntimeWriteProductionCapability
  close(): Promise<void>
}

/**
 * 已安装 CLI 的生产恢复装配。Authority maintenance client 每次操作单独打开并关闭，
 * 避免与随后使用同一持久 Authority 状态的 Artifact Store recovery 同时持有状态库。
 */
export async function openRuntimeWriteProduction(input: {
  homeDir: string
  projectRoot: string
  installation: RuntimeInstallation
  runStore: RuntimeRunStore
  startAuthorityHost?: typeof startRuntimeAuthorityHost
  openArtifactAuthority?: typeof openRuntimeArtifactStoreAuthority
}): Promise<OpenRuntimeWriteProductionResult> {
  const layout = runtimeLayout(input.homeDir)
  const ownedResources = await RuntimeOwnedResourceRegistry.open({
    statePath: join(layout.state, 'owned-resources.sqlite'),
    testWorkspaceRoots: [input.projectRoot, input.installation.versionRoot],
    operations: createRuntimeOwnedResourceOperations(layout.state),
  })
  let closed = false
  const requireOpen = () => {
    if (closed) throw productionWiringError('E2E_RUNTIME_WRITE_PRODUCTION_CLOSED')
  }
  const snapshotFor = async (record: { ownerMarker: { projectIdentityDigest: string; runId: string } }) => {
    requireOpen()
    const snapshot = await input.runStore.getRun(
      record.ownerMarker.projectIdentityDigest, record.ownerMarker.runId,
    )
    if (snapshot === undefined) throw productionWiringError('E2E_RUNTIME_RUN_NOT_FOUND')
    return snapshot
  }
  const reservationQueries = new Map<string, ReturnType<typeof reservationQuery>>()
  const withMaintenance = async <T>(snapshot: RuntimeRunSnapshot,
    operation: (client: AuthorityMaintenanceRpcClient) => Promise<T>): Promise<T> => {
    requireOpen()
    const projection = projectRuntimeWriteSnapshot(snapshot)
    const host = await (input.startAuthorityHost ?? startRuntimeAuthorityHost)({
      homeDir: input.homeDir, installation: input.installation, subject: localAuthoritySubject(),
    })
    let client: (AuthorityMaintenanceRpcClient & { destroy(): void }) | undefined
    let primary: unknown
    try {
      const approvalBinding = runtimeApprovalExecutionBinding(projection.grant.approvalContext)
      await host.activateRecoveryGrant({ grant: projection.grant, approvalBinding })
      const connection = host.executionRpcConnection(approvalBinding)
      try {
        client = createAuthorityMaintenanceRpcClient({
          credential: connection.credential,
          verifierMaterial: connection.verifierMaterial,
          expectedPublicKeyDigest: connection.verifierMaterial.publicKeyDigest,
          transport: createAuthenticatedRpcHttpTransport(connection.endpoint),
          approvalBinding: connection.approvalBinding,
        })
      } finally { connection.credential.sessionKeyBase64Url = '' }
      return await operation(client)
    } catch (error) {
      primary = error
      throw error
    } finally {
      const cleanup: unknown[] = []
      try { client?.destroy() } catch (error) { cleanup.push(error) }
      try { await host.close() } catch (error) { cleanup.push(error) }
      if (cleanup.length > 0 && primary === undefined) throw new AggregateError(cleanup)
    }
  }
  const recovery = new RuntimeRecoveryCoordinator({
    runStore: input.runStore,
    installation: { verify: async (snapshot) => {
      const installed = await inspectRuntimeInstallation({ homeDir: input.homeDir })
      const ok = installed.installationDigest === input.installation.installationDigest
        && snapshot.runtimeInstallationDigest === installed.installationDigest
      return verification('installation', { expected: input.installation.installationDigest,
        actual: installed.installationDigest }, ok, 'E2E_RUNTIME_INSTALLATION_BINDING_MISMATCH')
    } },
    state: { verify: async (snapshot) => {
      const current = await input.runStore.getRun(snapshot.projectIdentityDigest, snapshot.runId)
      if (current === undefined || canonicalizeJson(current) !== canonicalizeJson(snapshot)
        || snapshot.executionAttempt === undefined) return verification(
        'state', current ?? null, false, 'E2E_RUNTIME_RECOVERY_STATE_CHANGED',
      )
      return await input.runStore.verifyWriteRecoveryReady(
        snapshot.projectIdentityDigest, snapshot.runId, snapshot.executionAttempt.attemptId,
      )
    } },
    journal: { verify: async (snapshot) => {
      // getRun 的持久读取会先验证 Run/global journal、snapshot tail 与 lease ledger 闭合。
      const current = await input.runStore.getRun(snapshot.projectIdentityDigest, snapshot.runId)
      const ok = current !== undefined && canonicalizeJson(current) === canonicalizeJson(snapshot)
      return verification('journal', current ?? null, ok, 'E2E_RUNTIME_JOURNAL_INTEGRITY_FAILED')
    } },
    resources: ownedResources,
    reservation: {
      inspect: async (record) => {
        const snapshot = await snapshotFor(record)
        const projection = projectRuntimeWriteSnapshot(snapshot)
        const query = reservationQuery(projection, record.attemptId,
          'reservation' in record ? record.reservation?.reservationId : undefined)
        const observed = await withMaintenance(snapshot, async (client) => await client.queryReservation(query))
        if (observed === undefined) return { status: 'absent' as const }
        reservationQueries.set(observed.reservationId, query)
        return reservationObservation(observed)
      },
      markUnknown: async ({ record, reservationId, reason }) => {
        const snapshot = await snapshotFor(record)
        const projection = projectRuntimeWriteSnapshot(snapshot)
        const query = reservationQueries.get(reservationId)
          ?? reservationQuery(projection, record.attemptId, reservationId)
        return await withMaintenance(snapshot, async (client) =>
          await client.markReservationUnknown(query, reason))
      },
    },
    lease: {
      inspect: async (record) => {
        const snapshot = await snapshotFor(record)
        const lease = await withMaintenance(snapshot, async (client) => await client.queryLease(
          record.lease.leaseId, record.lease.fencingToken, record.lease.targetFingerprintDigest,
        ))
        if (lease.status === 'released') return {
          status: 'released' as const,
          cleanupDigest: lease.cleanupDigest!,
          receiptDigest: digestText('authority-lease-terminal-receipt/v1', canonicalizeJson({
            leaseId: lease.leaseId, fencingToken: lease.fencingToken,
            targetFingerprint: lease.resourceFingerprint, terminalStatus: 'released',
            cleanupDigest: lease.cleanupDigest,
          })),
        }
        if (lease.status === 'quarantined') return {
          status: 'quarantined' as const,
          quarantineReason: lease.quarantineReason!,
          receiptDigest: digestText('authority-lease-terminal-receipt/v1', canonicalizeJson({
            leaseId: lease.leaseId, fencingToken: lease.fencingToken,
            targetFingerprint: lease.resourceFingerprint, terminalStatus: 'quarantined',
            quarantineReason: lease.quarantineReason,
          })),
        }
        return { status: lease.status }
      },
      quarantine: async ({ record, leaseId, fencingToken, targetFingerprint, reason }) => {
        const snapshot = await snapshotFor(record)
        return await withMaintenance(snapshot, async (client) => await client.quarantineLease({
          leaseId, fencingToken, targetFingerprint, reason,
        }))
      },
    },
    artifacts: { recover: async (snapshot) => {
      const authority = await (input.openArtifactAuthority ?? openRuntimeArtifactStoreAuthority)({
        homeDir: input.homeDir, installation: input.installation, subject: localAuthoritySubject(),
      })
      try {
        const store = new LocalArtifactStore(input.projectRoot, {
          ...authority,
          auditStagedGeneration: async () => {
            throw productionWiringError('E2E_RUNTIME_RECOVERY_STAGED_GENERATION_UNTRUSTED')
          },
        })
        const active = await store.recover(snapshot.assetId)
        return verification('artifact-recovery', active ?? null, true)
      } finally { await authority.close() }
    } },
    frozen: { verify: async (snapshot) => verifyFrozenArtifacts(snapshot) },
    resume: { evaluate: async (snapshot) => ({
      allowed: false,
      next: 'safety-blocked',
      summaryDigest: digestText('runtime-write-production-resume/v1', canonicalizeJson({
        runId: snapshot.runId, workflow: snapshot.workflow, decision: 'manual-reconciliation-required',
      })),
      reasonCode: 'E2E_RUNTIME_WRITE_EFFECT_UNCERTAIN',
    }) },
    now: () => new Date(),
  })
  const capability = authorizeRuntimeWriteProduction({
    recovery,
    ownedResources,
    prepareCleanup: async (checkpoint) => {
      const lock = await input.runStore.acquireRunLock(checkpoint.projectIdentityDigest, checkpoint.runId)
      try {
        await input.runStore.prepareWriteCleanup({ ...checkpoint, lock })
      } finally { await lock.close() }
    },
  })
  return {
    capability,
    async close() {
      if (closed) return
      closed = true
      ownedResources.close()
    },
  }
}

function reservationQuery(projection: ReturnType<typeof projectRuntimeWriteSnapshot>,
  attemptId: string, reservationId?: string) {
  return {
    grantId: projection.grant.grantId,
    capabilityId: projection.capability.capabilityId,
    actionId: projection.actionId,
    attemptId,
    ...(reservationId === undefined ? {} : { reservationId }),
  }
}

function reservationObservation(reservation: CapabilityReservation) {
  if (reservation.status === 'completed') return {
    status: 'completed' as const,
    reservationId: reservation.reservationId,
    outcomeDigest: reservation.outcomeDigest!,
    receiptDigest: digestText('authority-reservation-terminal-receipt/v1', canonicalizeJson({
      reservationId: reservation.reservationId, grantId: reservation.grantId,
      capabilityId: reservation.capabilityId, actionId: reservation.actionId,
      attemptId: reservation.attemptId, terminalStatus: 'completed',
      outcomeDigest: reservation.outcomeDigest,
    })),
  }
  return { status: reservation.status, reservationId: reservation.reservationId }
}

function verifyFrozenArtifacts(snapshot: RuntimeRunSnapshot) {
  let ok = true
  for (const [type, artifact] of Object.entries(snapshot.frozenArtifacts)) {
    const schema = ArtifactSchemaRegistry[type as keyof typeof ArtifactSchemaRegistry]
    const parsed = schema?.safeParse(artifact)
    if (!parsed?.success || artifact.contentDigest !== digestArtifactContent(
      `artifact-content/${artifact.schemaVersion}/${type}`, artifact as unknown as Record<string, unknown>,
    ) || snapshot.artifactDigests[type] !== artifact.contentDigest) ok = false
  }
  return verification('frozen-artifacts', snapshot.frozenArtifacts, ok,
    'E2E_RUNTIME_RECOVERY_FROZEN_DIGEST_INVALID')
}

function verification(label: string, value: unknown, ok: boolean, reasonCode?: string) {
  return {
    ok,
    summaryDigest: digestText(`runtime-write-production-${label}/v1`, canonicalizeJson(value)),
    ...(!ok && reasonCode !== undefined ? { reasonCode } : {}),
  }
}

interface BrowserOwnerProcessSecurity {
  inspectOwnerProcess(pid: number): Promise<
    | { status: 'alive'; startIdentity: string }
    | { status: 'dead' }
    | { status: 'unknown' }
  >
}

export function createRuntimeOwnedResourceOperations(
  stateRoot: string,
): Readonly<Record<RuntimeOwnedResourceRecord['kind'], RuntimeOwnedResourceOperations>> {
  return createRuntimeOwnedResourceOperationsWithTestControl(
    stateRoot, { inspectOwnerProcess: inspectProcessConservatively },
  )
}

/** 仅供仓库内安全回归注入 OS 进程观察；生产装配必须使用固定入口。 */
export function createRuntimeOwnedResourceOperationsWithTestControl(
  stateRoot: string,
  security: BrowserOwnerProcessSecurity,
): Readonly<Record<RuntimeOwnedResourceRecord['kind'], RuntimeOwnedResourceOperations>> {
  const browser: RuntimeOwnedResourceOperations = {
    inspect: async (record) => await inspectBrowserProfile(stateRoot, record, security),
    cleanup: async (record) => {
      const observation = await inspectBrowserProfile(stateRoot, record, security)
      if (observation.status !== 'owned') throw productionWiringError(
        'E2E_RUNTIME_OWNED_RESOURCE_CLEANUP_FENCED',
      )
      const descriptor = parseBrowserDescriptor(record)
      const before = await lstat(descriptor.profileDir)
      const isolated = join(dirname(descriptor.profileDir),
        `.recovery-${record.resourceId.replace(/[^A-Za-z0-9._-]/g, '_')}`)
      await rename(descriptor.profileDir, isolated)
      const after = await lstat(isolated)
      if (before.dev !== after.dev || before.ino !== after.ino) {
        throw productionWiringError('E2E_RUNTIME_OWNED_RESOURCE_CLEANUP_FENCED')
      }
      await rm(isolated, { recursive: true, force: false })
      return { receiptDigest: digestText('runtime-browser-profile-recovery-cleanup/v1', canonicalizeJson({
        resourceId: record.resourceId, descriptorDigest: record.descriptorDigest,
      })) }
    },
  }
  const gateway: RuntimeOwnedResourceOperations = {
    inspect: async (record) => await inspectGatewayEndpoint(stateRoot, record),
    cleanup: async (record) => {
      const observation = await inspectGatewayEndpoint(stateRoot, record)
      if (observation.status !== 'owned') throw productionWiringError(
        'E2E_RUNTIME_OWNED_RESOURCE_CLEANUP_FENCED',
      )
      const descriptor = parseGatewayDescriptor(record)
      await rm(descriptor.markerPath, { force: false })
      return { receiptDigest: digestText('runtime-gateway-endpoint-recovery-cleanup/v1', canonicalizeJson({
        resourceId: record.resourceId, descriptorDigest: record.descriptorDigest,
      })) }
    },
  }
  return { 'browser-profile-lock': browser, 'loopback-endpoint': gateway }
}

async function inspectBrowserProfile(
  stateRoot: string, record: RuntimeOwnedResourceRecord,
  security: BrowserOwnerProcessSecurity,
): Promise<Awaited<ReturnType<RuntimeOwnedResourceOperations['inspect']>>> {
  try { return await inspectBrowserProfileUnchecked(stateRoot, record, security) }
  catch { return ownedObservation(record, 'owner-mismatch', 'browser-inspection-uncertain') }
}

async function inspectBrowserProfileUnchecked(
  stateRoot: string, record: RuntimeOwnedResourceRecord,
  security: BrowserOwnerProcessSecurity,
): Promise<Awaited<ReturnType<RuntimeOwnedResourceOperations['inspect']>>> {
  let descriptor: ReturnType<typeof parseBrowserDescriptor>
  try {
    descriptor = parseBrowserDescriptor(record)
    await assertBrowserDescriptorPath(stateRoot, record, descriptor)
  } catch {
    return ownedObservation(record, 'owner-mismatch', 'browser-descriptor-invalid')
  }
  const profile = await safeLstat(descriptor.profileDir)
  if (profile === undefined) return ownedObservation(record, 'absent', 'browser-profile-absent')
  if (!profile.isDirectory() || profile.isSymbolicLink() || (profile.mode & 0o777) !== 0o700
    || !currentUserOwns(profile.uid)) return ownedObservation(record, 'owner-mismatch', 'browser-profile-node')
  if (await realpath(dirname(descriptor.profileDir)) !== dirname(descriptor.profileDir)
    || await realpath(descriptor.profileDir) !== descriptor.profileDir) {
    return ownedObservation(record, 'owner-mismatch', 'browser-profile-ancestor')
  }
  const marker = parseBrowserMarker(await readSecureJson(descriptor.markerPath), record, descriptor)
  if (marker === undefined || marker.profile.device !== String(profile.dev)
    || marker.profile.inode !== String(profile.ino)) {
    return ownedObservation(record, 'owner-mismatch', 'browser-owner-marker')
  }
  const processState = await security.inspectOwnerProcess(marker.ownerProcess.pid)
  if (processState.status !== 'dead') return ownedObservation(record, 'owner-mismatch',
    processState.status === 'alive' && processState.startIdentity !== marker.ownerProcess.startIdentity
      ? 'browser-supervisor-pid-reused' : 'browser-supervisor-not-proven-dead')
  return ownedObservation(record, 'owned', 'browser-profile-owned-idle')
}

async function inspectGatewayEndpoint(
  stateRoot: string, record: RuntimeOwnedResourceRecord,
): Promise<Awaited<ReturnType<RuntimeOwnedResourceOperations['inspect']>>> {
  try { return await inspectGatewayEndpointUnchecked(stateRoot, record) }
  catch { return ownedObservation(record, 'owner-mismatch', 'gateway-inspection-uncertain') }
}

async function inspectGatewayEndpointUnchecked(
  stateRoot: string, record: RuntimeOwnedResourceRecord,
): Promise<Awaited<ReturnType<RuntimeOwnedResourceOperations['inspect']>>> {
  let descriptor: ReturnType<typeof parseGatewayDescriptor>
  try {
    descriptor = parseGatewayDescriptor(record)
    assertGatewayDescriptorPath(stateRoot, record, descriptor)
  } catch {
    return ownedObservation(record, 'owner-mismatch', 'gateway-descriptor-invalid')
  }
  const markerNode = await safeLstat(descriptor.markerPath)
  if (markerNode === undefined) return ownedObservation(record, 'absent', 'gateway-marker-absent')
  if (await realpath(dirname(descriptor.markerPath)) !== dirname(descriptor.markerPath)) {
    return ownedObservation(record, 'owner-mismatch', 'gateway-marker-ancestor')
  }
  const markerValue = await readSecureJson(descriptor.markerPath)
  if (markerValue === undefined) return ownedObservation(record, 'owner-mismatch', 'gateway-marker-node')
  const marker = parseGatewayMarker(markerValue, record, descriptor)
  if (marker === undefined) return ownedObservation(record, 'owner-mismatch', 'gateway-owner-marker')
  if (marker.pid !== undefined && processMayBeAlive(marker.pid)) {
    return ownedObservation(record, 'owner-mismatch', 'gateway-process-live-or-reused')
  }
  if (marker.endpoint !== undefined && !await loopbackEndpointDefinitelyClosed(marker.endpoint)) {
    return ownedObservation(record, 'owner-mismatch', 'gateway-endpoint-live-or-unknown')
  }
  return ownedObservation(record, 'owned', `gateway-${marker.phase}-owned-idle`)
}

function parseBrowserDescriptor(record: RuntimeOwnedResourceRecord): {
  schemaVersion: '1.0.0'; profileDir: string; markerPath: string
  profileParent: { canonicalPath: string; device: string; inode: string }
} {
  const value = record.descriptor
  if (!isPlainRecord(value)
    || !hasExactKeys(value, ['markerPath', 'profileDir', 'profileParent', 'schemaVersion'])
    || value.schemaVersion !== '1.0.0' || typeof value.profileDir !== 'string'
    || typeof value.markerPath !== 'string' || !isPathIdentity(value.profileParent)) {
    throw productionWiringError('E2E_RUNTIME_OWNED_RESOURCE_DESCRIPTOR_INVALID')
  }
  return { schemaVersion: '1.0.0', profileDir: value.profileDir, markerPath: value.markerPath,
    profileParent: value.profileParent }
}

function parseGatewayDescriptor(record: RuntimeOwnedResourceRecord): {
  schemaVersion: '1.0.0'; markerPath: string; sessionNonce: string
} {
  const value = record.descriptor
  if (!isPlainRecord(value) || !hasExactKeys(value, ['markerPath', 'schemaVersion', 'sessionNonce'])
    || value.schemaVersion !== '1.0.0' || typeof value.markerPath !== 'string'
    || typeof value.sessionNonce !== 'string' || !/^[a-f0-9]{64}$/.test(value.sessionNonce)) {
    throw productionWiringError('E2E_RUNTIME_OWNED_RESOURCE_DESCRIPTOR_INVALID')
  }
  return { schemaVersion: '1.0.0', markerPath: value.markerPath, sessionNonce: value.sessionNonce }
}

async function assertBrowserDescriptorPath(
  stateRoot: string,
  record: RuntimeOwnedResourceRecord,
  descriptor: ReturnType<typeof parseBrowserDescriptor>,
): Promise<void> {
  const expectedParent = join(resolve(stateRoot), record.ownerMarker.runId, 'browser')
  if (!isAbsolute(descriptor.profileDir) || dirname(descriptor.profileDir) !== expectedParent
    || !basename(descriptor.profileDir).startsWith('profile-')
    || descriptor.markerPath !== join(descriptor.profileDir, '.owner.json')) throw productionWiringError(
    'E2E_RUNTIME_OWNED_RESOURCE_PATH_INVALID',
  )
  assertWithinState(stateRoot, descriptor.markerPath)
  const parent = await lstat(expectedParent)
  if (!parent.isDirectory() || parent.isSymbolicLink()
    || await realpath(expectedParent) !== descriptor.profileParent.canonicalPath
    || String(parent.dev) !== descriptor.profileParent.device
    || String(parent.ino) !== descriptor.profileParent.inode) {
    throw productionWiringError('E2E_RUNTIME_OWNED_RESOURCE_PATH_INVALID')
  }
}

function assertGatewayDescriptorPath(
  stateRoot: string,
  record: RuntimeOwnedResourceRecord,
  descriptor: ReturnType<typeof parseGatewayDescriptor>,
): void {
  const expectedParent = join(resolve(stateRoot), record.ownerMarker.runId, 'gateway')
  if (!isAbsolute(descriptor.markerPath) || dirname(descriptor.markerPath) !== expectedParent
    || basename(descriptor.markerPath) !== `session-${record.ownerMarker.markerDigest.slice(7, 31)}.owner.json`) {
    throw productionWiringError('E2E_RUNTIME_OWNED_RESOURCE_PATH_INVALID')
  }
  assertWithinState(stateRoot, descriptor.markerPath)
}

function parseBrowserMarker(
  value: unknown,
  record: RuntimeOwnedResourceRecord,
  descriptor: ReturnType<typeof parseBrowserDescriptor>,
): { profile: { device: string; inode: string }; ownerProcess: {
  role: 'host' | 'supervisor'; pid: number; startIdentity: string
} } | undefined {
  if (!isPlainRecord(value)
    || !hasExactKeys(value, ['descriptorDigest', 'kind', 'ownerMarker', 'ownerProcess', 'phase',
      'profile', 'profileParent', 'schemaVersion'])
    || value.schemaVersion !== '1.0.0' || value.kind !== 'browser-profile-lock'
    || !['prepared', 'supervising', 'launched'].includes(String(value.phase))
    || value.descriptorDigest !== record.descriptorDigest
    || canonicalizeJson(value.ownerMarker) !== canonicalizeJson(record.ownerMarker)
    || canonicalizeJson(value.profileParent) !== canonicalizeJson(descriptor.profileParent)
    || !isNodeIdentity(value.profile) || !isPlainRecord(value.ownerProcess)
    || !hasExactKeys(value.ownerProcess, ['pid', 'role', 'startIdentity'])
    || !['host', 'supervisor'].includes(String(value.ownerProcess.role))
    || !Number.isSafeInteger(value.ownerProcess.pid) || (value.ownerProcess.pid as number) <= 0
    || typeof value.ownerProcess.startIdentity !== 'string'
    || value.ownerProcess.startIdentity.length === 0 || value.ownerProcess.startIdentity.length > 512) return undefined
  return { profile: value.profile, ownerProcess: value.ownerProcess as {
    role: 'host' | 'supervisor'; pid: number; startIdentity: string
  } }
}

function isNodeIdentity(value: unknown): value is { device: string; inode: string } {
  return isPlainRecord(value) && hasExactKeys(value, ['device', 'inode'])
    && typeof value.device === 'string' && /^\d+$/.test(value.device)
    && typeof value.inode === 'string' && /^\d+$/.test(value.inode)
}

function isPathIdentity(value: unknown): value is { canonicalPath: string; device: string; inode: string } {
  return isPlainRecord(value) && hasExactKeys(value, ['canonicalPath', 'device', 'inode'])
    && typeof value.canonicalPath === 'string' && value.canonicalPath.length > 0
    && typeof value.device === 'string' && /^\d+$/.test(value.device)
    && typeof value.inode === 'string' && /^\d+$/.test(value.inode)
}

function parseGatewayMarker(
  value: unknown,
  record: RuntimeOwnedResourceRecord,
  descriptor: ReturnType<typeof parseGatewayDescriptor>,
): { phase: 'prepared' | 'spawned' | 'listening'; pid?: number; endpoint?: string } | undefined {
  if (!isPlainRecord(value)) return undefined
  const phase = value.phase
  const keys = phase === 'prepared'
    ? ['descriptorDigest', 'kind', 'ownerMarker', 'phase', 'schemaVersion', 'sessionNonce']
    : phase === 'spawned'
      ? ['descriptorDigest', 'kind', 'ownerMarker', 'phase', 'pid', 'schemaVersion', 'sessionNonce']
      : ['descriptorDigest', 'endpoint', 'kind', 'ownerMarker', 'phase', 'pid', 'schemaVersion', 'sessionNonce']
  if (!hasExactKeys(value, keys) || value.schemaVersion !== '1.0.0' || value.kind !== 'loopback-endpoint'
    || !['prepared', 'spawned', 'listening'].includes(String(phase))
    || value.descriptorDigest !== record.descriptorDigest || value.sessionNonce !== descriptor.sessionNonce
    || canonicalizeJson(value.ownerMarker) !== canonicalizeJson(record.ownerMarker)) return undefined
  if (phase === 'prepared') return { phase }
  if (!Number.isSafeInteger(value.pid) || (value.pid as number) < 1) return undefined
  if (phase === 'spawned') return { phase, pid: value.pid as number }
  if (typeof value.endpoint !== 'string' || !canonicalLoopbackEndpoint(value.endpoint)) return undefined
  return { phase: 'listening', pid: value.pid as number, endpoint: value.endpoint }
}

async function readSecureJson(path: string): Promise<unknown | undefined> {
  let handle: Awaited<ReturnType<typeof open>>
  try { handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW) }
  catch (error) { if (nodeError(error, 'ENOENT')) return undefined; return undefined }
  try {
    const metadata = await handle.stat()
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1
      || (metadata.mode & 0o777) !== 0o600 || !currentUserOwns(metadata.uid)
      || metadata.size < 2 || metadata.size > 65_536) return undefined
    try { return JSON.parse(await handle.readFile('utf8')) }
    catch { return undefined }
  } finally { await handle.close() }
}

async function safeLstat(path: string): Promise<Stats | undefined> {
  try { return await lstat(path) }
  catch (error) { if (nodeError(error, 'ENOENT')) return undefined; throw error }
}

function processMayBeAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true }
  catch (error) { return !nodeError(error, 'ESRCH') }
}

function inspectProcessConservatively(pid: number): Promise<
  { status: 'alive'; startIdentity: string } | { status: 'dead' } | { status: 'unknown' }
> {
  try { process.kill(pid, 0); return Promise.resolve({ status: 'alive', startIdentity: 'unverified' }) }
  catch (error) {
    return Promise.resolve(nodeError(error, 'ESRCH') ? { status: 'dead' } : { status: 'unknown' })
  }
}

async function loopbackEndpointDefinitelyClosed(endpoint: string): Promise<boolean> {
  if (!canonicalLoopbackEndpoint(endpoint)) return false
  const url = new URL(endpoint)
  return await new Promise<boolean>((resolvePromise) => {
    const socket = connect({ host: '127.0.0.1', port: Number(url.port) })
    const timer = setTimeout(() => { socket.destroy(); resolvePromise(false) }, 500)
    socket.once('connect', () => { clearTimeout(timer); socket.destroy(); resolvePromise(false) })
    socket.once('error', (error: NodeJS.ErrnoException) => {
      clearTimeout(timer)
      resolvePromise(error.code === 'ECONNREFUSED')
    })
  })
}

function canonicalLoopbackEndpoint(value: string): boolean {
  try {
    const url = new URL(value)
    const port = Number(url.port)
    return url.protocol === 'http:' && url.hostname === '127.0.0.1' && url.port === String(port)
      && Number.isInteger(port) && port >= 1 && port <= 65_535 && url.pathname === '/'
      && url.search === '' && url.hash === '' && url.username === '' && url.password === ''
      && value === `http://127.0.0.1:${port}`
  } catch { return false }
}

function ownedObservation(
  record: RuntimeOwnedResourceRecord,
  status: 'owned' | 'absent' | 'owner-mismatch',
  reason: string,
) {
  return {
    status,
    summaryDigest: digestText('runtime-owned-resource-inspection/v1', canonicalizeJson({
      resourceId: record.resourceId, descriptorDigest: record.descriptorDigest, status, reason,
    })),
  }
}

function assertWithinState(stateRoot: string, candidate: string): void {
  const rel = relative(resolve(stateRoot), resolve(candidate))
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw productionWiringError(
    'E2E_RUNTIME_OWNED_RESOURCE_PATH_INVALID',
  )
}

function currentUserOwns(uid: number): boolean {
  return typeof process.getuid !== 'function' || uid === process.getuid()
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasExactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  return Object.keys(value).sort().join('\0') === [...keys].sort().join('\0')
}

function nodeError(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code
}

function localAuthoritySubject(): string {
  if (typeof process.getuid !== 'function') throw productionWiringError('E2E_RUNTIME_PLATFORM_UNSUPPORTED')
  return `local:uid:${process.getuid()}`
}

function productionWiringError(code: string): E2EError {
  return new E2EError({ code, category: 'safety', message: code, retryable: false })
}
