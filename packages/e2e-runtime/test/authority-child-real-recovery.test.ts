import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, test, vi } from 'vitest'
import { isoCBOR } from '@simplewebauthn/server/helpers'
import {
  LocalApprovalAuthority,
  LocalLeaseAuthority,
  createAuthenticatedRpcHttpTransport,
  createAuthorityExecutionRpcClients,
  startAuthorityExecutionRpcHostProcess,
} from '@mutil-skills/e2e-authority'
import {
  RuntimeRequestEnvelopeSchema,
  canonicalizeJson,
  digestArtifactContent,
  digestText,
} from '@mutil-skills/e2e-contracts'
import { RuntimeAuthorityHost } from '../src/authority-host.js'
import { E2ERuntimeHost } from '../src/runtime-host.js'
import { RuntimeRunStore, type RuntimeRunSnapshot } from '../src/run-store.js'
import { resolveProjectIdentity } from '../src/project-identity.js'
import { createRuntimeTestRoots } from './fixtures.js'

const installationDigest = `sha256:${'a'.repeat(64)}`
const fixedNow = '2026-07-17T04:00:00.000Z'
const now = () => new Date(fixedNow)
const digest = (value: string) => digestText('real-runtime-authority-recovery/v1', value)

test('real Runtime recovers a child-committed Grant after Host1 closes without a second WebAuthn assertion', async ({ skip }) => {
  const roots = await createRuntimeTestRoots()
  const approvalPath = join(roots.root, 'approval.sqlite')
  const leasePath = join(roots.root, 'lease.sqlite')
  const stateEncryptionKey = randomBytes(32)
  const approver = { subject: 'local:user', roles: ['e2e-approver'] }
  const credential = createTestAuthenticatorCredential()
  const runStore = await RuntimeRunStore.open({ homeDir: roots.home, projectRoot: roots.project })
  let currentAuthority: RuntimeAuthorityHost | undefined
  try {
    await mkdir(join(roots.project, '.biztest'), { recursive: true })
    await writeFile(join(roots.project, '.biztest', 'project.json'), JSON.stringify({
      schemaVersion: '1.0.0', projectId: 'PROJECT-REAL-RECOVERY',
    }))
    const identity = await resolveProjectIdentity(roots.project)
    const normalizedText = '# 订单\n必须显示待审核订单。'
    const requirementModel: Record<string, any> = {
      artifactId: 'ARTIFACT-REQUIREMENT-MODEL', artifactType: 'requirement-model', schemaVersion: '1.0.0',
      engineVersion: '0.3.0', assetId: 'ASSET-REAL-RECOVERY', prdRevision: digest('prd'),
      generationId: 'RUN-REAL-RECOVERY', createdAt: fixedNow, contentDigest: '', signatures: [],
      dependencies: [], graph: { defines: [], references: [] }, content: { modelRevision: 1,
        requirements: [{ reqId: 'REQ-1', revision: 1, title: '订单列表', actors: ['operator'],
          entities: ['order'], preconditions: [], rules: [{ ruleId: 'RULE-1', category: 'business',
            statement: '显示待审核订单', sourceRefs: ['PRD-1'], certainty: 'explicit',
            oracleIds: ['ORACLE-1'] }], states: [], transitions: [], observableOutcomes: [{
            oracleId: 'ORACLE-1', statement: '页面显示待审核订单' }], applicability: [],
          sourceRefs: ['PRD-1'], status: 'active' }], coupledDimensions: [],
        applicabilityRules: ['RULE-1'], modelDecisionDigest: digest('model-decision') },
    }
    requirementModel.contentDigest = digestArtifactContent(
      'artifact-content/1.0.0/requirement-model', requirementModel,
    )
    const snapshot: RuntimeRunSnapshot = {
      schemaVersion: '1.1.0', runId: 'RUN-REAL-RECOVERY', assetId: 'ASSET-REAL-RECOVERY',
      projectIdentityDigest: identity.digest, runtimeInstallationDigest: installationDigest,
      workflow: {
        current: 'awaiting-execution-approval', sequence: 8,
        eventChainDigest: `sha256:${'8'.repeat(64)}`,
      },
      artifactDigests: { 'prd-source': digest('prd'), scope: digest('scope'),
        'requirement-model': requirementModel.contentDigest },
      frozenArtifacts: { 'requirement-model': requirementModel as never },
      trustedExecutionFacts: { 'prd-source-snapshot': {
        schemaVersion: '1.0.0', sourceRef: 'inputs/prd.md', normalizedText,
        normalizedDigest: digestText('e2e-prd-normalized-source/v1', normalizedText),
        byteLength: Buffer.byteLength(normalizedText),
      } },
      requestResponses: {}, createdAt: fixedNow, updatedAt: fixedNow,
    }
    const seedRequestDigest = digest('seed-request')
    await runStore.beginRequest('SEED-REAL-RECOVERY', seedRequestDigest)
    const seedLock = await runStore.acquireRunLock(identity.digest, snapshot.runId)
    try {
      await runStore.createRunOutcome(
        snapshot, 'SEED-REAL-RECOVERY', seedRequestDigest, {}, seedLock,
      )
    } finally { await seedLock.close() }

    const seedAuthority = await LocalApprovalAuthority.open({
      issuer: 'authority', keyId: 'approval-key', now, statePath: approvalPath,
      stateEncryptionKey, testWorkspaceRoots: [process.cwd()], approvalIdentities: [approver],
      authenticateApproverSession: (_sessionId, expected) => ({
        subject: approver.subject, runId: 'RUN-PREFLIGHT', ...expected, installationDigest,
        origin: 'http://localhost:43210', issuedAt: fixedNow, expiresAt: '2026-07-17T04:05:00.000Z',
      }),
    })
    await seedAuthority.createWebAuthnCredentialRepository().insert({
      id: credential.id, publicKey: credential.publicKey, counter: 0,
      transports: ['internal'], subject: approver.subject,
    })
    const discoverySubject = {
      schemaVersion: '1.1.0' as const, assetId: snapshot.assetId,
      prdRevision: snapshot.artifactDigests['prd-source']!, scopeDigest: snapshot.artifactDigests.scope!,
      environment: 'test' as const, baseOrigin: 'https://test.example.com', actor: 'operator',
      expectedPageIdentity: {
        url: 'https://test.example.com/orders/1', title: 'Order', heading: 'Order 1', ariaSignals: ['main'],
      },
      bootstrapIntentsDigest: digest('bootstrap'),
      requests: [],
      actions: [{
        actionId: 'DISCOVERY-REAL', operation: 'local-navigation' as const, maxUses: 1 as const, requestIds: [],
      }],
    }
    const discovery = await seedAuthority.issueDiscoveryGrant({
      subject: discoverySubject, approvalSessionRef: 'seed-session', ttlMs: 120_000,
    })
    const discoveryReservation = await seedAuthority.reserveForSubject({
      grant: discovery, currentSubject: discoverySubject,
      capabilityId: discovery.capabilities[0]!.capabilityId,
      actionId: discovery.capabilities[0]!.actionId, attemptId: 'ATTEMPT-DISCOVERY-REAL',
    })
    const preflightDigest = await seedAuthority.completeDiscoveryPreflight({
      grant: discovery, currentSubject: discoverySubject,
      reservationId: discoveryReservation.reservationId,
      capabilityId: discovery.capabilities[0]!.capabilityId,
      outcome: { status: 'ready', observedIdentity: {
        url: discoverySubject.expectedPageIdentity.url,
        title: discoverySubject.expectedPageIdentity.title,
        headings: [discoverySubject.expectedPageIdentity.heading],
        role: discoverySubject.actor, ariaSignals: ['main'],
      } },
    })
    const grantSubject = {
      schemaVersion: '2.0.0' as const, assetId: snapshot.assetId,
      prdRevision: snapshot.artifactDigests['prd-source']!, executionDigest: digest('execution'),
      scopeDigest: snapshot.artifactDigests.scope!, requirementModelDigest: digest('model'),
      coveragePolicyDigest: digest('coverage'), universeDigest: digest('universe'),
      caseDigest: digest('cases'), actionMapDigest: digest('actions'), policyDigest: digest('policy'),
      executionContractDigest: digest('contract'), runBundleProjectionDigest: digest('bundle'),
      environment: 'test' as const, baseOrigin: discoverySubject.baseOrigin, actor: discoverySubject.actor,
      discoveryGrantId: discovery.grantId, preflightDigest,
      actions: [{
        actionId: 'ACTION-WRITE-REAL', effect: 'reversible-write' as const,
        dataLeaseId: 'LEASE-REAL', resourceKey: 'order:1', fencingToken: 1,
        cleanupPlanDigest: digest('cleanup'),
        requests: [{
          intentId: 'INTENT-WRITE-REAL', method: 'POST', canonicalOrigin: discoverySubject.baseOrigin,
          exactPath: '/orders/1', query: [], payload: { kind: 'no-body' as const },
          targetFingerprint: digest('target'), maxRequests: 1, expectedOrder: 1,
        }],
      }],
    }
    seedAuthority.close()
    const leaseAuthority = await LocalLeaseAuthority.open({
      now, statePath: leasePath, testWorkspaceRoots: [process.cwd()],
    })
    await leaseAuthority.acquireBound({
      leaseId: 'LEASE-REAL', runId: snapshot.runId, resourceKey: 'order:1',
      resourceFingerprint: digest('target'), exclusive: true, ttlMs: 300_000,
    })
    leaseAuthority.close()
    const request = RuntimeRequestEnvelopeSchema.parse({
      schemaVersion: '1.0.0', requestId: 'APPROVE-REAL-RECOVERY',
      client: { name: 'test', version: '1.0.0' }, command: 'open-approval', projectRoot: roots.project,
      payload: { runId: snapshot.runId, approvalType: 'execution', grantSubject },
    })
    const hostOptions: Parameters<typeof startAuthorityExecutionRpcHostProcess>[0] = {
      rpc: { issuer: 'authority-host', keyId: 'rpc-key', clientId: 'runtime-parent' },
      approval: {
        issuer: 'authority', keyId: 'approval-key', statePath: approvalPath,
        stateEncryptionKey, testWorkspaceRoots: [process.cwd()], approvalIdentities: [approver],
      },
      lease: { statePath: leasePath, testWorkspaceRoots: [process.cwd()] },
      userPresence: {
        installationDigest,
        assets: {
          indexHtml: Buffer.from('<!doctype html>'), approvalJavaScript: Buffer.from('void 0'),
          simpleWebAuthnBrowser: Buffer.from('void 0'),
        },
      },
      clock: { kind: 'fixed-test-only', now: fixedNow },
    }
    const startAuthority = async (): Promise<RuntimeAuthorityHost> => {
      const processHandle = await startAuthorityExecutionRpcHostProcess(hostOptions)
      return new RuntimeAuthorityHost({ processHandle, installationDigest })
    }
    try { currentAuthority = await startAuthority() }
    catch (error) {
      if (isPlatformPermissionError(error)) { skip(); return }
      throw error
    }
    const firstCredential = currentAuthority.executionRpcConnection({
      runId: snapshot.runId, approvalType: 'execution',
      subjectDigest: digest('placeholder'), installationDigest,
    }).credential.sessionKeyBase64Url
    let assertions = 0
    const runtime = new E2ERuntimeHost({
      installation: {
        version: '0.0.0', protocolMajor: 1, versionRoot: '/runtime', entrypoint: '/runtime/repo-e2e.js',
        installationDigest, sourceRepositoryIndependent: true,
      },
      doctor: async () => { throw new Error('not used') }, runStore, now,
      authorityHostFactory: async () => currentAuthority!,
      presentUserPresenceUrl: async (url) => {
        assertions += 1
        await completeWebAuthnApproval(url, credential)
      },
    })
    const originalWriteTrustedFactOutcome = runStore.writeTrustedFactOutcome.bind(runStore)
    const confirmationResponse = await runtime.handle(request, JSON.stringify(request))
    expect(confirmationResponse).toMatchObject({ ok: true, result: {
      status: 'confirmation-required', approvalMode: 'webauthn',
    } })
    if (!confirmationResponse.ok) throw new Error('semantic confirmation missing')
    const confirmation = confirmationResponse.result as { confirmationId: string; subjectDigest: string }
    const confirmedRequest = RuntimeRequestEnvelopeSchema.parse({
      schemaVersion: '1.0.0', requestId: 'APPROVE-REAL-RECOVERY-CONFIRMED',
      client: { name: 'test', version: '1.0.0' }, command: 'confirm-approval', projectRoot: roots.project,
      payload: { runId: snapshot.runId, confirmationId: confirmation.confirmationId,
        subjectDigest: confirmation.subjectDigest },
    })
    vi.spyOn(runStore, 'writeTrustedFactOutcome')
      .mockRejectedValueOnce(new Error('simulated Run Store fsync failure'))
      .mockImplementation(originalWriteTrustedFactOutcome)

    const first = await runtime.handle(confirmedRequest, JSON.stringify(confirmedRequest))
    if (first.error?.code === 'E2E_APPROVAL_PLATFORM_PERMISSION_DENIED') { skip(); return }
    expect(first).toMatchObject({
      ok: false, error: { code: 'E2E_RUNTIME_APPROVAL_PERSISTENCE_PENDING' },
    })
    expect(assertions).toBe(1)

    await currentAuthority.close()
    currentAuthority = undefined
    currentAuthority = await startAuthority()
    const second = await runtime.handle(confirmedRequest, JSON.stringify(confirmedRequest))
    expect(second).toMatchObject({
      ok: true,
      result: {
        signedGrant: { subject: grantSubject },
        approvalBinding: { runId: snapshot.runId, installationDigest, approvalType: 'execution' },
      },
    })
    expect(assertions).toBe(1)
    const result = second.result as any
    const connection = currentAuthority.executionRpcConnection(result.approvalBinding)
    expect(connection.credential.sessionKeyBase64Url).not.toBe(firstCredential)
    const clients = createAuthorityExecutionRpcClients({
      credential: connection.credential,
      approvalBinding: connection.approvalBinding,
      verifierMaterial: connection.verifierMaterial,
      expectedPublicKeyDigest: connection.verifierMaterial.publicKeyDigest,
      transport: createAuthenticatedRpcHttpTransport(connection.endpoint),
      now,
    })
    try {
      await expect(clients.gatewayAuthority.verifyForSubject(result.signedGrant, grantSubject))
        .resolves.toEqual({ allowed: true })
      await expect(clients.gatewayAuthority.reserveForSubject({
        grant: result.signedGrant, currentSubject: grantSubject,
        capabilityId: result.signedGrant.capabilities[0].capabilityId,
        actionId: grantSubject.actions[0].actionId, attemptId: 'ATTEMPT-REAL-RECOVERY',
        attemptContext: {
          assetId: snapshot.assetId, generationId: snapshot.runId,
          prdRevision: snapshot.artifactDigests['prd-source']!, runId: snapshot.runId, caseId: 'CASE-1',
        },
      })).resolves.toMatchObject({ status: 'reserved', attemptId: 'ATTEMPT-REAL-RECOVERY' })
    } finally { clients.destroy() }
  } finally {
    await currentAuthority?.close().catch(() => undefined)
    stateEncryptionKey.fill(0)
    await runStore.close()
    await rm(roots.root, { recursive: true, force: true })
  }
}, 20_000)

function createTestAuthenticatorCredential(): {
  id: string
  publicKey: string
  privateKey: ReturnType<typeof generateKeyPairSync>['privateKey']
} {
  const keys = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  const jwk = keys.publicKey.export({ format: 'jwk' })
  const cose = isoCBOR.encode(new Map<number, number | Uint8Array>([
    [1, 2], [3, -7], [-1, 1], [-2, Buffer.from(jwk.x!, 'base64url')], [-3, Buffer.from(jwk.y!, 'base64url')],
  ]))
  return {
    id: randomBytes(16).toString('base64url'),
    publicKey: Buffer.from(cose).toString('base64url'),
    privateKey: keys.privateKey,
  }
}

async function completeWebAuthnApproval(
  rawUrl: string,
  credential: ReturnType<typeof createTestAuthenticatorCredential>,
): Promise<void> {
  const url = new URL(rawUrl)
  const bearer = url.hash.slice(1)
  const sessionResponse = await fetch(`${url.origin}/session`, {
    headers: { authorization: `Bearer ${bearer}` },
  })
  const approval = await sessionResponse.json() as { challenge: string; sessionId: string }
  const clientData = Buffer.from(canonicalizeJson({
    type: 'webauthn.get', challenge: approval.challenge, origin: url.origin,
  }))
  const authenticatorData = Buffer.alloc(37)
  createHash('sha256').update('localhost').digest().copy(authenticatorData)
  authenticatorData[32] = 0x05
  authenticatorData.writeUInt32BE(1, 33)
  const signature = sign('sha256', Buffer.concat([
    authenticatorData, createHash('sha256').update(clientData).digest(),
  ]), credential.privateKey)
  const response = await fetch(`${url.origin}/submit`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${bearer}`, origin: url.origin, 'content-type': 'application/json',
    },
    body: canonicalizeJson({
      sessionId: approval.sessionId, challenge: approval.challenge, credentialId: credential.id,
      response: {
        id: credential.id, rawId: credential.id, type: 'public-key',
        response: {
          clientDataJSON: clientData.toString('base64url'),
          authenticatorData: authenticatorData.toString('base64url'),
          signature: signature.toString('base64url'), userHandle: null,
        },
      },
    }),
  })
  expect(response.status, await response.text()).toBe(204)
}

function isPlatformPermissionError(error: unknown): boolean {
  return typeof error === 'object' && error !== null
    && (error as { code?: unknown }).code === 'E2E_APPROVAL_PLATFORM_PERMISSION_DENIED'
}
