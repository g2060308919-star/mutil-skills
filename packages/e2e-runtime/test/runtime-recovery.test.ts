import { digestText } from '@mutil-skills/e2e-contracts'
import { createWorkflow } from '@mutil-skills/e2e-engine'
import { describe, expect, test } from 'vitest'
import { RuntimeRecoveryCoordinator } from '../src/runtime-recovery.js'
import { RuntimeRunStore, type RuntimeRunSnapshot } from '../src/run-store.js'
import { createRuntimeOwnedResourceMarker } from '../src/write-attempt.js'
import { createRuntimeTestRoots } from './fixtures.js'
import { installRunStoreCommitAbortForTest, readRunStoreSnapshotForTest,
  removeRunStoreCommitAbortForTest } from './run-store-harness.js'

const digest = (value: string): string => digestText('runtime-recovery-test/v1', value)

describe('RuntimeRecoveryCoordinator', () => {
  test('固定顺序恢复不确定写：markUnknown→quarantine，Browser 调用为 0', async () => {
    const fixture = await recoveryFixture()
    const calls: string[] = []
    let browserCalls = 0
    const coordinator = new RuntimeRecoveryCoordinator({
      runStore: fixture.store,
      installation: { verify: async () => { calls.push('installation'); return verified('installation') } },
      state: { verify: async () => { calls.push('state'); return verified('state') } },
      journal: { verify: async () => { calls.push('journal'); return verified('journal') } },
      resources: { cleanupOwned: async () => { calls.push('owner-cleanup'); return {
        status: 'cleaned', summaryDigest: digest('owner-cleanup'),
      } } },
      reservation: {
        inspect: async () => { calls.push('reservation-inspect'); return {
          status: 'reserved', reservationId: 'RESERVATION-RECOVERY-1',
        } },
        markUnknown: async () => { calls.push('mark-unknown'); return digest('unknown-receipt') },
      },
      lease: { quarantine: async () => { calls.push('quarantine'); return digest('quarantine-receipt') } },
      artifacts: { recover: async () => { calls.push('artifact-recovery'); return verified('artifact') } },
      frozen: { verify: async () => { calls.push('frozen-digest'); return verified('frozen') } },
      resume: { evaluate: async () => { calls.push('resume-edge'); return {
        allowed: true, next: 'manual-reconcile', summaryDigest: digest('resume'),
      } } },
      now: () => new Date('2026-07-17T02:00:00.000Z'),
    })
    const result = await coordinator.recover({
      projectIdentityDigest: digest('project'), runId: 'RUN-RECOVERY-1',
      attemptId: 'ATTEMPT-WRITE-RECOVERY-1',
    })
    expect(result).toMatchObject({ status: 'recovered', writeState: 'effect-unknown',
      next: 'manual-reconcile', browserCalls: 0 })
    expect(browserCalls).toBe(0)
    expect(calls).toEqual([
      'installation', 'state', 'journal', 'owner-cleanup', 'reservation-inspect',
      'mark-unknown', 'quarantine', 'artifact-recovery', 'frozen-digest', 'resume-edge',
    ])
    await expect(fixture.store.getWriteAttempt(
      digest('project'), 'RUN-RECOVERY-1', 'ATTEMPT-WRITE-RECOVERY-1',
    )).resolves.toMatchObject({ state: 'effect-unknown' })
    const raw = readRunStoreSnapshotForTest(fixture.roots.home)
    const key = `${digest('project')}\0RUN-RECOVERY-1`
    const rows = (raw.journals as Record<string, Array<{ event: Record<string, unknown> }>>)[key]!
    const recoveryEvents = rows.map((row) => row.event)
      .filter((event) => event.kind === 'runtime-recovery-step')
    expect(recoveryEvents.map((event) => event.step)).toEqual([
      'installation', 'state', 'journal', 'owner-marker-cleanup', 'reservation-reconcile',
      'artifact-recovery', 'frozen-digest', 'resume-edge',
    ])
    expect(recoveryEvents.every((event) => typeof event.summaryDigest === 'string'
      && /^sha256:[a-f0-9]{64}$/.test(event.summaryDigest))).toBe(true)
    await fixture.store.close()
  })

  test('错误 owner marker 保持资源原样并在 reservation/Artifact 前 blocked', async () => {
    const fixture = await recoveryFixture()
    const calls: string[] = []
    const coordinator = new RuntimeRecoveryCoordinator({
      runStore: fixture.store,
      installation: { verify: async () => verified('installation') },
      state: { verify: async () => verified('state') },
      journal: { verify: async () => verified('journal') },
      resources: { cleanupOwned: async () => { calls.push('owner-mismatch'); return {
        status: 'owner-mismatch', summaryDigest: digest('owner-mismatch'),
      } } },
      reservation: {
        inspect: async () => { calls.push('must-not-inspect'); return {
          status: 'reserved', reservationId: 'RESERVATION-RECOVERY-1',
        } },
        markUnknown: async () => digest('must-not-mark'),
      },
      lease: { quarantine: async () => digest('must-not-quarantine') },
      artifacts: { recover: async () => { calls.push('must-not-recover'); return verified('artifact') } },
      frozen: { verify: async () => verified('frozen') },
      resume: { evaluate: async () => ({ allowed: false, next: 'blocked', summaryDigest: digest('resume') }) },
      now: () => new Date('2026-07-17T02:00:00.000Z'),
    })
    await expect(coordinator.recover({
      projectIdentityDigest: digest('project'), runId: 'RUN-RECOVERY-1',
      attemptId: 'ATTEMPT-WRITE-RECOVERY-1',
    })).resolves.toMatchObject({ status: 'blocked', reasonCode: 'E2E_RUNTIME_RECOVERY_OWNER_MISMATCH' })
    expect(calls).toEqual(['owner-mismatch'])
    await fixture.store.close()
  })

  test('journal 证明失败立即 blocked，owner cleanup、reservation、Artifact 和 Browser 都不调用', async () => {
    const fixture = await recoveryFixture()
    const calls: string[] = []
    const coordinator = new RuntimeRecoveryCoordinator({
      runStore: fixture.store,
      installation: { verify: async () => { calls.push('installation'); return verified('installation') } },
      state: { verify: async () => { calls.push('state'); return verified('state') } },
      journal: { verify: async () => { calls.push('journal'); return {
        ok: false, reasonCode: 'E2E_RUNTIME_JOURNAL_INTEGRITY_FAILED', summaryDigest: digest('journal-bad'),
      } } },
      resources: { cleanupOwned: async () => { calls.push('must-not-clean'); return {
        status: 'cleaned', summaryDigest: digest('cleanup'),
      } } },
      reservation: {
        inspect: async () => { calls.push('must-not-inspect'); return {
          status: 'reserved', reservationId: 'RESERVATION-RECOVERY-1',
        } },
        markUnknown: async () => digest('must-not-mark'),
      },
      lease: { quarantine: async () => digest('must-not-quarantine') },
      artifacts: { recover: async () => { calls.push('must-not-recover'); return verified('artifact') } },
      frozen: { verify: async () => verified('frozen') },
      resume: { evaluate: async () => ({ allowed: false, next: 'blocked', summaryDigest: digest('resume') }) },
      now: () => new Date('2026-07-17T02:00:00.000Z'),
    })
    await expect(coordinator.recover({
      projectIdentityDigest: digest('project'), runId: 'RUN-RECOVERY-1',
      attemptId: 'ATTEMPT-WRITE-RECOVERY-1',
    })).resolves.toMatchObject({
      status: 'blocked', reasonCode: 'E2E_RUNTIME_JOURNAL_INTEGRITY_FAILED', browserCalls: 0,
    })
    expect(calls).toEqual(['installation', 'state', 'journal'])
    await expect(fixture.store.getRun(digest('project'), 'RUN-RECOVERY-1')).resolves.toMatchObject({
      workflow: { current: 'safety-blocked' },
      writeAttempts: { 'ATTEMPT-WRITE-RECOVERY-1': { state: 'effect-unknown' } },
    })
    await expect(fixture.store.beginRequest('REQUEST-WRITE-RECOVERY', digest('write-request')))
      .resolves.toMatchObject({ kind: 'replay', response: { ok: false,
        error: { code: 'E2E_RUNTIME_JOURNAL_INTEGRITY_FAILED', terminalState: 'safety-blocked' } } })
    await fixture.store.close()
  })

  test('外部 verify/inspect 调用期间不持有 mutation lock，并把 prepared inspect 到的 reservation 先落盘', async () => {
    const fixture = await recoveryFixture({ observeReservation: false })
    let probeAcquired = false
    const verifyWithoutLongLock = async () => {
      const probe = await fixture.store.acquireRunLock(digest('project'), 'RUN-RECOVERY-1')
      probeAcquired = true
      await probe.close()
      return verified('verified-with-probe')
    }
    const coordinator = new RuntimeRecoveryCoordinator({
      runStore: fixture.store,
      installation: { verify: verifyWithoutLongLock }, state: { verify: async () => verified('state') },
      journal: { verify: async () => verified('journal') },
      resources: { cleanupOwned: async () => ({ status: 'absent', summaryDigest: digest('cleanup') }) },
      reservation: { inspect: async () => ({ status: 'reserved', reservationId: 'RESERVATION-DISCOVERED' }),
        markUnknown: async () => digest('unknown-receipt') },
      lease: { quarantine: async () => digest('quarantine-receipt') },
      artifacts: { recover: async () => verified('artifact') }, frozen: { verify: async () => verified('frozen') },
      resume: { evaluate: async () => ({ allowed: true, next: 'manual-reconcile', summaryDigest: digest('resume') }) },
      now: () => new Date('2026-07-17T02:00:00.000Z'),
    })
    await expect(coordinator.recover({ projectIdentityDigest: digest('project'), runId: 'RUN-RECOVERY-1',
      attemptId: 'ATTEMPT-WRITE-RECOVERY-1' })).resolves.toMatchObject({ writeState: 'effect-unknown' })
    expect(probeAcquired).toBe(true)
    await expect(fixture.store.getWriteAttempt(digest('project'), 'RUN-RECOVERY-1',
      'ATTEMPT-WRITE-RECOVERY-1')).resolves.toMatchObject({
        reservation: { reservationId: 'RESERVATION-DISCOVERED' },
        recovery: { markUnknown: { receiptDigest: digest('unknown-receipt') },
          quarantine: { receiptDigest: digest('quarantine-receipt') } },
      })
    await fixture.store.close()
  })

  test('markUnknown 外调成功但 receipt 落盘前崩溃时，以同一 operationId 精确重放', async () => {
    const fixture = await recoveryFixture()
    const operations: string[] = []
    let abortAfterFirstUnknown = true
    const dependencies = {
      runStore: fixture.store,
      installation: { verify: async () => verified('installation') }, state: { verify: async () => verified('state') },
      journal: { verify: async () => verified('journal') },
      resources: { cleanupOwned: async () => ({ status: 'absent' as const, summaryDigest: digest('cleanup') }) },
      reservation: {
        inspect: async () => ({ status: operations.length === 0 ? 'reserved' as const : 'unknown' as const,
          reservationId: 'RESERVATION-RECOVERY-1' }),
        markUnknown: async (input: { operationId: string }) => {
          operations.push(input.operationId)
          if (abortAfterFirstUnknown) {
            abortAfterFirstUnknown = false
            installRunStoreCommitAbortForTest(fixture.roots.home)
          }
          return digest('unknown-receipt')
        },
      },
      lease: { quarantine: async () => digest('quarantine-receipt') },
      artifacts: { recover: async () => verified('artifact') }, frozen: { verify: async () => verified('frozen') },
      resume: { evaluate: async () => ({ allowed: true, next: 'manual-reconcile', summaryDigest: digest('resume') }) },
      now: () => new Date('2026-07-17T02:00:00.000Z'),
    }
    await expect(new RuntimeRecoveryCoordinator(dependencies).recover({ projectIdentityDigest: digest('project'),
      runId: 'RUN-RECOVERY-1', attemptId: 'ATTEMPT-WRITE-RECOVERY-1' })).rejects.toThrow(/TEST_KILL_POINT/)
    removeRunStoreCommitAbortForTest(fixture.roots.home)
    await expect(fixture.store.getWriteAttempt(digest('project'), 'RUN-RECOVERY-1',
      'ATTEMPT-WRITE-RECOVERY-1')).resolves.toMatchObject({ recovery: {
        markUnknown: { operationId: operations[0] },
      } })
    await expect(new RuntimeRecoveryCoordinator(dependencies).recover({ projectIdentityDigest: digest('project'),
      runId: 'RUN-RECOVERY-1', attemptId: 'ATTEMPT-WRITE-RECOVERY-1' })).resolves.toMatchObject({ status: 'recovered' })
    expect(operations).toHaveLength(2)
    expect(operations[1]).toBe(operations[0])
    await fixture.store.close()
  })

  test('quarantine 外调成功但 receipt 落盘前崩溃时，以同一 operationId 和 target 精确重放', async () => {
    const fixture = await recoveryFixture()
    const quarantineInputs: Array<{ operationId: string; targetFingerprint: string }> = []
    let abortAfterFirstQuarantine = true
    const dependencies = {
      runStore: fixture.store,
      installation: { verify: async () => verified('installation') }, state: { verify: async () => verified('state') },
      journal: { verify: async () => verified('journal') },
      resources: { cleanupOwned: async () => ({ status: 'absent' as const, summaryDigest: digest('cleanup') }) },
      reservation: { inspect: async () => ({ status: 'unknown' as const,
        reservationId: 'RESERVATION-RECOVERY-1' }), markUnknown: async () => digest('unknown-receipt') },
      lease: { quarantine: async (input: { operationId: string; targetFingerprint: string }) => {
        quarantineInputs.push(input)
        if (abortAfterFirstQuarantine) {
          abortAfterFirstQuarantine = false
          installRunStoreCommitAbortForTest(fixture.roots.home)
        }
        return digest('quarantine-receipt')
      } },
      artifacts: { recover: async () => verified('artifact') }, frozen: { verify: async () => verified('frozen') },
      resume: { evaluate: async () => ({ allowed: true, next: 'manual-reconcile', summaryDigest: digest('resume') }) },
      now: () => new Date('2026-07-17T02:00:00.000Z'),
    }
    const recoveryInput = { projectIdentityDigest: digest('project'), runId: 'RUN-RECOVERY-1',
      attemptId: 'ATTEMPT-WRITE-RECOVERY-1' }
    await expect(new RuntimeRecoveryCoordinator(dependencies).recover(recoveryInput)).rejects.toThrow(/TEST_KILL_POINT/)
    removeRunStoreCommitAbortForTest(fixture.roots.home)
    await expect(new RuntimeRecoveryCoordinator(dependencies).recover(recoveryInput))
      .resolves.toMatchObject({ status: 'recovered' })
    expect(quarantineInputs).toHaveLength(2)
    expect(quarantineInputs[1]).toEqual(quarantineInputs[0])
    expect(quarantineInputs[0]!.targetFingerprint).toBe(digest('target-fingerprint'))
    await fixture.store.close()
  })
})

function verified(label: string) {
  return { ok: true as const, summaryDigest: digest(label) }
}

async function recoveryFixture(options: { observeReservation?: boolean } = {}) {
  const roots = await createRuntimeTestRoots()
  const store = await RuntimeRunStore.open({ homeDir: roots.home, projectRoot: roots.project })
  await store.beginRequest('REQUEST-CREATE-RECOVERY', digest('create-request'))
  const createLock = await store.acquireRunLock(digest('project'), 'RUN-RECOVERY-1')
  const snapshot: RuntimeRunSnapshot = {
    schemaVersion: '1.2.0', runId: 'RUN-RECOVERY-1', assetId: 'ASSET-RECOVERY-1',
    projectIdentityDigest: digest('project'), runtimeInstallationDigest: digest('installation'),
    workflow: createWorkflow(), artifactDigests: {}, frozenArtifacts: {}, trustedExecutionFacts: {},
    writeAttempts: {}, requestResponses: {}, createdAt: '2026-07-17T01:00:00.000Z',
    updatedAt: '2026-07-17T01:00:00.000Z',
  }
  await store.createRunOutcome(
    snapshot, 'REQUEST-CREATE-RECOVERY', digest('create-request'), { ok: true }, createLock,
  )
  await createLock.close()
  await store.beginRequest('REQUEST-WRITE-RECOVERY', digest('write-request'))
  const writeLock = await store.acquireRunLock(digest('project'), 'RUN-RECOVERY-1')
  await store.prepareWriteAttempt({
    projectIdentityDigest: digest('project'), runId: 'RUN-RECOVERY-1',
    requestId: 'REQUEST-WRITE-RECOVERY', requestDigest: digest('write-request'),
    attemptId: 'ATTEMPT-WRITE-RECOVERY-1', actionId: 'ACTION-WRITE-RECOVERY-1',
    lease: { leaseId: 'LEASE-RECOVERY-1', fencingToken: 17,
      targetFingerprintDigest: digest('target-fingerprint') },
    executionFencingToken: 19,
    ownerMarker: createRuntimeOwnedResourceMarker({
      runtimeInstallationDigest: digest('installation'), projectIdentityDigest: digest('project'),
      runId: 'RUN-RECOVERY-1', attemptId: 'ATTEMPT-WRITE-RECOVERY-1', ownerNonce: 'OWNER-RECOVERY-1',
    }),
    preparedAt: '2026-07-17T01:00:00.000Z', lock: writeLock,
  })
  if (options.observeReservation !== false) await store.observeWriteReservation({
      projectIdentityDigest: digest('project'), runId: 'RUN-RECOVERY-1',
      attemptId: 'ATTEMPT-WRITE-RECOVERY-1', reservationId: 'RESERVATION-RECOVERY-1',
      observedAt: '2026-07-17T01:00:01.000Z', lock: writeLock,
    })
  await writeLock.close()
  return { roots, store }
}
