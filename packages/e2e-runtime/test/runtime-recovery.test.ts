import { canonicalizeJson, digestText, E2EError } from '@mutil-skills/e2e-contracts'
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
      lease: { inspect: async () => ({ status: 'active' as const }),
        quarantine: async () => { calls.push('quarantine'); return digest('quarantine-receipt') } },
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
      lease: { inspect: async () => ({ status: 'active' }),
        quarantine: async () => digest('must-not-quarantine') },
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
      lease: { inspect: async () => ({ status: 'active' }),
        quarantine: async () => digest('must-not-quarantine') },
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
      lease: { inspect: async () => ({ status: 'active' as const }),
        quarantine: async () => digest('quarantine-receipt') },
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
      lease: { inspect: async () => ({ status: 'active' as const }),
        quarantine: async () => digest('quarantine-receipt') },
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
      lease: { inspect: async () => ({ status: 'active' as const }),
        quarantine: async (input: { operationId: string; targetFingerprint: string }) => {
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

  test('Lease 已释放但 terminal checkpoint 落盘前崩溃时，重启查询并复用终态回执且不得改写为 quarantine', async () => {
    const fixture = await recoveryFixture()
    const cleanupDigest = digest('verified-cleanup')
    const cleanupLock = await fixture.store.acquireRunLock(digest('project'), 'RUN-RECOVERY-1')
    await fixture.store.prepareWriteCleanup({
      projectIdentityDigest: digest('project'), runId: 'RUN-RECOVERY-1',
      attemptId: 'ATTEMPT-WRITE-RECOVERY-1', cleanupDigest,
      preparedAt: '2026-07-17T01:30:00.000Z', lock: cleanupLock,
    })
    await cleanupLock.close()
    const receiptDigest = digestText('authority-lease-terminal-receipt/v1', canonicalizeJson({
      leaseId: 'LEASE-RECOVERY-1', fencingToken: 17,
      targetFingerprint: digest('target-fingerprint'), terminalStatus: 'released', cleanupDigest,
    }))
    let inspectCalls = 0
    let quarantineCalls = 0
    let abortTerminalCheckpoint = true
    const originalRecordReceipt = fixture.store.recordWriteRecoveryReceipt.bind(fixture.store)
    fixture.store.recordWriteRecoveryReceipt = async (input) => {
      if (input.operation === 'leaseTerminal' && abortTerminalCheckpoint) {
        abortTerminalCheckpoint = false
        throw new Error('TEST_KILL_AFTER_LEASE_TERMINAL_QUERY')
      }
      return await originalRecordReceipt(input)
    }
    const dependencies = {
      runStore: fixture.store,
      installation: { verify: async () => verified('installation') }, state: { verify: async () => verified('state') },
      journal: { verify: async () => verified('journal') },
      resources: { cleanupOwned: async () => ({ status: 'absent' as const, summaryDigest: digest('cleanup') }) },
      reservation: { inspect: async () => ({ status: 'reserved' as const,
        reservationId: 'RESERVATION-RECOVERY-1' }), markUnknown: async () => digest('unknown-receipt') },
      lease: {
        inspect: async () => { inspectCalls += 1; return {
          status: 'released' as const, cleanupDigest, receiptDigest,
        } },
        quarantine: async () => { quarantineCalls += 1; return digest('must-not-quarantine') },
      },
      artifacts: { recover: async () => verified('artifact') }, frozen: { verify: async () => verified('frozen') },
      resume: { evaluate: async () => ({ allowed: true, next: 'manual-reconcile', summaryDigest: digest('resume') }) },
      now: () => new Date('2026-07-17T02:00:00.000Z'),
    }
    const recoveryInput = { projectIdentityDigest: digest('project'), runId: 'RUN-RECOVERY-1',
      attemptId: 'ATTEMPT-WRITE-RECOVERY-1' }
    await expect(new RuntimeRecoveryCoordinator(dependencies).recover(recoveryInput))
      .rejects.toThrow('TEST_KILL_AFTER_LEASE_TERMINAL_QUERY')
    await expect(new RuntimeRecoveryCoordinator(dependencies).recover(recoveryInput))
      .resolves.toMatchObject({ status: 'recovered', writeState: 'effect-unknown', browserCalls: 0 })
    expect(inspectCalls).toBe(2)
    expect(quarantineCalls).toBe(0)
    await expect(fixture.store.getWriteAttempt(digest('project'), 'RUN-RECOVERY-1',
      'ATTEMPT-WRITE-RECOVERY-1')).resolves.toMatchObject({ recovery: {
        leaseTerminal: { receiptDigest },
      } })
    await fixture.store.close()
  })

  test.each([
    ['missing', undefined],
    ['mismatch', digest('other-cleanup')],
  ] as const)('Lease 已释放但 cleanupPreparedDigest %s 时 fail closed', async (_case, preparedDigest) => {
    const fixture = await recoveryFixture()
    const leaseCleanupDigest = digest('verified-cleanup')
    if (preparedDigest !== undefined) {
      const lock = await fixture.store.acquireRunLock(digest('project'), 'RUN-RECOVERY-1')
      await fixture.store.prepareWriteCleanup({
        projectIdentityDigest: digest('project'), runId: 'RUN-RECOVERY-1',
        attemptId: 'ATTEMPT-WRITE-RECOVERY-1', cleanupDigest: preparedDigest,
        preparedAt: '2026-07-17T01:30:00.000Z', lock,
      })
      await lock.close()
    }
    let quarantineCalls = 0
    const coordinator = new RuntimeRecoveryCoordinator({
      runStore: fixture.store,
      installation: { verify: async () => verified('installation') }, state: { verify: async () => verified('state') },
      journal: { verify: async () => verified('journal') },
      resources: { cleanupOwned: async () => ({ status: 'absent', summaryDigest: digest('cleanup') }) },
      reservation: { inspect: async () => ({ status: 'reserved', reservationId: 'RESERVATION-RECOVERY-1' }),
        markUnknown: async () => digest('unknown-receipt') },
      lease: { inspect: async () => ({ status: 'released', cleanupDigest: leaseCleanupDigest,
        receiptDigest: digest('released-receipt') }),
      quarantine: async () => { quarantineCalls += 1; return digest('must-not-quarantine') } },
      artifacts: { recover: async () => verified('artifact') }, frozen: { verify: async () => verified('frozen') },
      resume: { evaluate: async () => ({ allowed: true, next: 'must-not-resume', summaryDigest: digest('resume') }) },
      now: () => new Date('2026-07-17T02:00:00.000Z'),
    })
    await expect(coordinator.recover({ projectIdentityDigest: digest('project'), runId: 'RUN-RECOVERY-1',
      attemptId: 'ATTEMPT-WRITE-RECOVERY-1' })).resolves.toMatchObject({
      status: 'blocked', reasonCode: 'E2E_RUNTIME_RECOVERY_CLEANUP_CHECKPOINT_MISMATCH', browserCalls: 0,
    })
    expect(quarantineCalls).toBe(0)
    await fixture.store.close()
  })

  test('outcome-prepared 与 Authority completed 使用同一 terminal receipt 域并恢复为 committed', async () => {
    const fixture = await recoveryFixture()
    const outcomeDigest = digest('authority-outcome')
    const receiptDigest = digestText('authority-reservation-terminal-receipt/v1', canonicalizeJson({
      reservationId: 'RESERVATION-RECOVERY-1', grantId: 'GRANT-1', capabilityId: 'CAP-1',
      actionId: 'ACTION-WRITE-RECOVERY-1', attemptId: 'ATTEMPT-WRITE-RECOVERY-1',
      terminalStatus: 'completed', outcomeDigest,
    }))
    const lock = await fixture.store.acquireRunLock(digest('project'), 'RUN-RECOVERY-1')
    await fixture.store.prepareWriteOutcome({
      projectIdentityDigest: digest('project'), runId: 'RUN-RECOVERY-1',
      attemptId: 'ATTEMPT-WRITE-RECOVERY-1', outcomeDigest, receiptDigest,
      preparedAt: '2026-07-17T01:00:02.000Z', lock,
    })
    await lock.close()
    let markUnknownCalls = 0
    let quarantineCalls = 0
    const coordinator = new RuntimeRecoveryCoordinator({
      runStore: fixture.store,
      installation: { verify: async () => verified('installation') },
      state: { verify: async () => verified('state') },
      journal: { verify: async () => verified('journal') },
      resources: { cleanupOwned: async () => ({ status: 'absent', summaryDigest: digest('cleanup') }) },
      reservation: {
        inspect: async () => ({ status: 'completed', reservationId: 'RESERVATION-RECOVERY-1',
          outcomeDigest, receiptDigest }),
        markUnknown: async () => { markUnknownCalls += 1; return digest('must-not-mark') },
      },
      lease: { inspect: async () => ({ status: 'active' }),
        quarantine: async () => { quarantineCalls += 1; return digest('must-not-quarantine') } },
      artifacts: { recover: async () => verified('artifact') },
      frozen: { verify: async () => verified('frozen') },
      resume: { evaluate: async () => ({ allowed: true, next: 'reporting', summaryDigest: digest('resume') }) },
      now: () => new Date('2026-07-17T02:00:00.000Z'),
    })
    await expect(coordinator.recover({ projectIdentityDigest: digest('project'), runId: 'RUN-RECOVERY-1',
      attemptId: 'ATTEMPT-WRITE-RECOVERY-1' })).resolves.toMatchObject({
      status: 'recovered', writeState: 'outcome-committed', browserCalls: 0,
    })
    expect(markUnknownCalls).toBe(0)
    expect(quarantineCalls).toBe(0)
    await fixture.store.close()
  })

  test.each([
    'installation',
    'state',
    'journal',
    'resources',
    'reservation-inspect',
    'reservation-mark-unknown',
    'lease-quarantine',
    'artifacts',
    'frozen',
    'resume',
  ] as const)('%s 外部证明异常时以 fresh context 持久阻断原请求且不调用 Browser', async (failurePoint) => {
    const fixture = await recoveryFixture()
    let browserCalls = 0
    const fail = (point: typeof failurePoint) => {
      if (point !== failurePoint) return
      throw new E2EError({
        code: point === 'artifacts'
          ? 'E2E_RUNTIME_RECOVERY_STAGED_GENERATION_UNTRUSTED'
          : `E2E_RUNTIME_RECOVERY_${point.toUpperCase().replaceAll('-', '_')}_PROOF_FAILED`,
        category: 'safety',
        message: `${point} proof failed`,
        retryable: false,
      })
    }
    const coordinator = new RuntimeRecoveryCoordinator({
      runStore: fixture.store,
      installation: { verify: async () => { fail('installation'); return verified('installation') } },
      state: { verify: async () => { fail('state'); return verified('state') } },
      journal: { verify: async () => { fail('journal'); return verified('journal') } },
      resources: { cleanupOwned: async () => { fail('resources'); return {
        status: 'absent', summaryDigest: digest('cleanup'),
      } } },
      reservation: {
        inspect: async () => { fail('reservation-inspect'); return {
          status: 'reserved', reservationId: 'RESERVATION-RECOVERY-1',
        } },
        markUnknown: async () => { fail('reservation-mark-unknown'); return digest('unknown-receipt') },
      },
      lease: { inspect: async () => ({ status: 'active' }),
        quarantine: async () => { fail('lease-quarantine'); return digest('quarantine-receipt') } },
      artifacts: { recover: async () => { fail('artifacts'); return verified('artifact') } },
      frozen: { verify: async () => { fail('frozen'); return verified('frozen') } },
      resume: { evaluate: async () => { fail('resume'); return {
        allowed: true, next: 'manual-reconcile', summaryDigest: digest('resume'),
      } } },
      now: () => new Date('2026-07-17T02:00:00.000Z'),
    })

    const result = await coordinator.recover({
      projectIdentityDigest: digest('project'), runId: 'RUN-RECOVERY-1',
      attemptId: 'ATTEMPT-WRITE-RECOVERY-1',
    })

    expect(result).toMatchObject({
      status: 'blocked',
      reasonCode: failurePoint === 'artifacts'
        ? 'E2E_RUNTIME_RECOVERY_STAGED_GENERATION_UNTRUSTED'
        : `E2E_RUNTIME_RECOVERY_${failurePoint.toUpperCase().replaceAll('-', '_')}_PROOF_FAILED`,
      browserCalls: 0,
    })
    expect(browserCalls).toBe(0)
    await expect(fixture.store.beginRequest('REQUEST-WRITE-RECOVERY', digest('write-request')))
      .resolves.toMatchObject({ kind: 'replay', response: { ok: false,
        error: { terminalState: 'safety-blocked' } } })
    await expect(fixture.store.getRun(digest('project'), 'RUN-RECOVERY-1')).resolves.toMatchObject({
      workflow: { current: 'safety-blocked' },
    })
    await fixture.store.close()
  })

  test('外部证明异常后若 fresh RunStore context 已不可安全读取则保留异常', async () => {
    const fixture = await recoveryFixture()
    const proofError = new E2EError({
      code: 'E2E_RUNTIME_RECOVERY_INSTALLATION_PROOF_FAILED', category: 'safety',
      message: 'installation proof failed', retryable: false,
    })
    let reads = 0
    const originalGetRun = fixture.store.getRun.bind(fixture.store)
    fixture.store.getRun = async (...input) => {
      reads += 1
      if (reads > 1) throw new E2EError({
        code: 'E2E_RUNTIME_JOURNAL_INTEGRITY_FAILED', category: 'safety',
        message: 'journal cannot be read safely', retryable: false,
      })
      return await originalGetRun(...input)
    }
    const coordinator = new RuntimeRecoveryCoordinator({
      runStore: fixture.store,
      installation: { verify: async () => { throw proofError } },
      state: { verify: async () => verified('state') }, journal: { verify: async () => verified('journal') },
      resources: { cleanupOwned: async () => ({ status: 'absent', summaryDigest: digest('cleanup') }) },
      reservation: { inspect: async () => ({ status: 'absent' }),
        markUnknown: async () => digest('unknown-receipt') },
      lease: { inspect: async () => ({ status: 'active' }),
        quarantine: async () => digest('quarantine-receipt') },
      artifacts: { recover: async () => verified('artifact') }, frozen: { verify: async () => verified('frozen') },
      resume: { evaluate: async () => ({ allowed: false, next: 'blocked', summaryDigest: digest('resume') }) },
      now: () => new Date('2026-07-17T02:00:00.000Z'),
    })

    await expect(coordinator.recover({ projectIdentityDigest: digest('project'), runId: 'RUN-RECOVERY-1',
      attemptId: 'ATTEMPT-WRITE-RECOVERY-1' })).rejects.toMatchObject({
        code: 'E2E_RUNTIME_JOURNAL_INTEGRITY_FAILED',
      })
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
