import { canonicalizeJson, digestText } from '@mutil-skills/e2e-contracts'
import { createWorkflow } from '@mutil-skills/e2e-engine'
import { describe, expect, test } from 'vitest'
import { RuntimeRunStore, type RuntimeRunSnapshot } from '../src/run-store.js'
import { createRuntimeOwnedResourceMarker } from '../src/write-attempt.js'
import { createRuntimeTestRoots } from './fixtures.js'
import {
  installRunStoreCommitAbortForTest,
  removeRunStoreCommitAbortForTest,
} from './run-store-harness.js'

const digest = (value: string): string => digestText('write-recovery-test/v1', value)

describe('durable WriteAttemptRecord', () => {
  test('严格持久化 prepared→reservation-observed→outcome-prepared→outcome-committed', async () => {
    const fixture = await writeStoreFixture()
    const lock = await fixture.store.acquireRunLock(digest('project'), 'RUN-WRITE-1')
    const prepared = await fixture.store.prepareWriteAttempt({ ...writeAttemptInput(), lock })
    expect(prepared).toMatchObject({ state: 'prepared', recordRevision: 1 })

    const reserved = await fixture.store.observeWriteReservation({
      projectIdentityDigest: digest('project'), runId: 'RUN-WRITE-1', attemptId: 'ATTEMPT-WRITE-1',
      reservationId: 'RESERVATION-WRITE-1', observedAt: '2026-07-17T01:00:01.000Z', lock,
    })
    expect(reserved).toMatchObject({
      state: 'reservation-observed', reservation: { reservationId: 'RESERVATION-WRITE-1' },
      recordRevision: 2,
    })
    const outcomePrepared = await fixture.store.prepareWriteOutcome({
      projectIdentityDigest: digest('project'), runId: 'RUN-WRITE-1', attemptId: 'ATTEMPT-WRITE-1',
      outcomeDigest: digest('outcome'), receiptDigest: digest('receipt'),
      preparedAt: '2026-07-17T01:00:02.000Z', lock,
    })
    expect(outcomePrepared).toMatchObject({ state: 'outcome-prepared', outcome: {
      outcomeDigest: digest('outcome'), receiptDigest: digest('receipt'),
    } })
    const committed = await fixture.store.commitWriteOutcome({
      projectIdentityDigest: digest('project'), runId: 'RUN-WRITE-1', attemptId: 'ATTEMPT-WRITE-1',
      outcomeDigest: digest('outcome'), receiptDigest: digest('receipt'),
      committedAt: '2026-07-17T01:00:03.000Z', lock,
    })
    expect(committed).toMatchObject({ state: 'outcome-committed', recordRevision: 4 })
    expect(committed.recordDigest).toBe(digestText(
      'runtime-write-attempt-record/v1',
      canonicalizeJson(Object.fromEntries(Object.entries(committed).filter(([key]) => key !== 'recordDigest'))),
    ))
    await lock.close()
    await fixture.store.close()
  })

  test('任意不确定 reservation 只能进入 effect-unknown，不能自动回退或提交 outcome', async () => {
    const fixture = await writeStoreFixture()
    const lock = await fixture.store.acquireRunLock(digest('project'), 'RUN-WRITE-1')
    await fixture.store.prepareWriteAttempt({ ...writeAttemptInput(), lock })
    await fixture.store.observeWriteReservation({
      projectIdentityDigest: digest('project'), runId: 'RUN-WRITE-1', attemptId: 'ATTEMPT-WRITE-1',
      reservationId: 'RESERVATION-WRITE-1', observedAt: '2026-07-17T01:00:01.000Z', lock,
    })
    const unknown = await fixture.store.markWriteEffectUnknown({
      projectIdentityDigest: digest('project'), runId: 'RUN-WRITE-1', attemptId: 'ATTEMPT-WRITE-1',
      reasonCode: 'E2E_RUNTIME_WRITE_EFFECT_UNCERTAIN', observedAt: '2026-07-17T01:00:02.000Z', lock,
    })
    expect(unknown).toMatchObject({ state: 'effect-unknown', effectUnknown: {
      reasonCode: 'E2E_RUNTIME_WRITE_EFFECT_UNCERTAIN',
    } })
    await expect(fixture.store.prepareWriteOutcome({
      projectIdentityDigest: digest('project'), runId: 'RUN-WRITE-1', attemptId: 'ATTEMPT-WRITE-1',
      outcomeDigest: digest('outcome'), receiptDigest: digest('receipt'),
      preparedAt: '2026-07-17T01:00:03.000Z', lock,
    })).rejects.toMatchObject({ code: 'E2E_RUNTIME_WRITE_ATTEMPT_TRANSITION_INVALID' })
    await lock.close()
    await fixture.store.close()
  })

  test('reservation-observed commit kill-window 原子保留 prepared，重开后不会猜测 reservation', async () => {
    const fixture = await writeStoreFixture()
    const lock = await fixture.store.acquireRunLock(digest('project'), 'RUN-WRITE-1')
    await fixture.store.prepareWriteAttempt({ ...writeAttemptInput(), lock })
    installRunStoreCommitAbortForTest(fixture.roots.home)
    await expect(fixture.store.observeWriteReservation({
      projectIdentityDigest: digest('project'), runId: 'RUN-WRITE-1', attemptId: 'ATTEMPT-WRITE-1',
      reservationId: 'RESERVATION-WRITE-1', observedAt: '2026-07-17T01:00:01.000Z', lock,
    })).rejects.toThrow(/TEST_KILL_POINT/)
    removeRunStoreCommitAbortForTest(fixture.roots.home)
    await lock.close()
    await fixture.store.close()

    const reopened = await RuntimeRunStore.open({
      homeDir: fixture.roots.home, projectRoot: fixture.roots.project,
    })
    const persisted = await reopened.getWriteAttempt(
      digest('project'), 'RUN-WRITE-1', 'ATTEMPT-WRITE-1',
    )
    expect(persisted).toMatchObject({ state: 'prepared' })
    expect(persisted).not.toHaveProperty('reservation')
    await reopened.close()
  })

  test('Authority complete 后 outcome-committed kill-window 保留 outcome-prepared 供精确 reconcile', async () => {
    const fixture = await writeStoreFixture()
    const lock = await fixture.store.acquireRunLock(digest('project'), 'RUN-WRITE-1')
    await fixture.store.prepareWriteAttempt({ ...writeAttemptInput(), lock })
    await fixture.store.observeWriteReservation({
      projectIdentityDigest: digest('project'), runId: 'RUN-WRITE-1', attemptId: 'ATTEMPT-WRITE-1',
      reservationId: 'RESERVATION-WRITE-1', observedAt: '2026-07-17T01:00:01.000Z', lock,
    })
    await fixture.store.prepareWriteOutcome({
      projectIdentityDigest: digest('project'), runId: 'RUN-WRITE-1', attemptId: 'ATTEMPT-WRITE-1',
      outcomeDigest: digest('outcome'), receiptDigest: digest('receipt'),
      preparedAt: '2026-07-17T01:00:02.000Z', lock,
    })
    installRunStoreCommitAbortForTest(fixture.roots.home)
    await expect(fixture.store.commitWriteOutcome({
      projectIdentityDigest: digest('project'), runId: 'RUN-WRITE-1', attemptId: 'ATTEMPT-WRITE-1',
      outcomeDigest: digest('outcome'), receiptDigest: digest('receipt'),
      committedAt: '2026-07-17T01:00:03.000Z', lock,
    })).rejects.toThrow(/TEST_KILL_POINT/)
    removeRunStoreCommitAbortForTest(fixture.roots.home)
    await lock.close()
    await fixture.store.close()
    const reopened = await RuntimeRunStore.open({
      homeDir: fixture.roots.home, projectRoot: fixture.roots.project,
    })
    await expect(reopened.getWriteAttempt(
      digest('project'), 'RUN-WRITE-1', 'ATTEMPT-WRITE-1',
    )).resolves.toMatchObject({
      state: 'outcome-prepared', outcome: {
        outcomeDigest: digest('outcome'), receiptDigest: digest('receipt'),
      },
    })
    await reopened.close()
  })
})

async function writeStoreFixture() {
  const roots = await createRuntimeTestRoots()
  const store = await RuntimeRunStore.open({ homeDir: roots.home, projectRoot: roots.project })
  await store.beginRequest('REQUEST-CREATE-WRITE', digest('create-request'))
  const createLock = await store.acquireRunLock(digest('project'), 'RUN-WRITE-1')
  const snapshot: RuntimeRunSnapshot = {
    schemaVersion: '1.2.0', runId: 'RUN-WRITE-1', assetId: 'ASSET-WRITE-1',
    projectIdentityDigest: digest('project'), runtimeInstallationDigest: digest('installation'),
    workflow: createWorkflow(), artifactDigests: {}, frozenArtifacts: {}, trustedExecutionFacts: {},
    writeAttempts: {}, requestResponses: {}, createdAt: '2026-07-17T01:00:00.000Z',
    updatedAt: '2026-07-17T01:00:00.000Z',
  }
  await store.createRunOutcome(
    snapshot, 'REQUEST-CREATE-WRITE', digest('create-request'), { ok: true }, createLock,
  )
  await createLock.close()
  await store.beginRequest('REQUEST-WRITE-1', digest('write-request'))
  return { roots, store }
}

function writeAttemptInput() {
  return {
    projectIdentityDigest: digest('project'), runId: 'RUN-WRITE-1',
    requestId: 'REQUEST-WRITE-1', requestDigest: digest('write-request'),
    attemptId: 'ATTEMPT-WRITE-1', actionId: 'ACTION-WRITE-1',
    lease: {
      leaseId: 'LEASE-WRITE-1', fencingToken: 7,
      targetFingerprintDigest: digest('target-fingerprint'),
    },
    executionFencingToken: 11,
    ownerMarker: createRuntimeOwnedResourceMarker({
      runtimeInstallationDigest: digest('installation'), projectIdentityDigest: digest('project'),
      runId: 'RUN-WRITE-1', attemptId: 'ATTEMPT-WRITE-1', ownerNonce: 'OWNER-WRITE-1',
    }),
    preparedAt: '2026-07-17T01:00:00.000Z',
  }
}
