import { afterEach, describe, expect, test } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LocalApprovalAuthority, SqliteSnapshotStore, createArtifactSignatureVerifier } from '@mutil-skills/e2e-authority'
import { canonicalizeJson, digestText } from '@mutil-skills/e2e-contracts'
import { RuntimeFullPlaywrightCheckpointStore } from '../src/runtime-full-playwright-checkpoint.js'

const paths: string[] = []
const d = (value: string) => digestText('runtime-full-playwright-checkpoint-test/v1', value)

afterEach(async () => { await Promise.all(paths.splice(0).map((path) => rm(path, { recursive: true, force: true }))) })

describe('persistent full Playwright terminal checkpoints', () => {
  test('进程重启后按 attempt+binding 恢复，不接受幂等冲突，并产出 Authority 可验签 receipt', async () => {
    const root = await mkdtemp(join(tmpdir(), 'full-checkpoint-')); paths.push(root)
    const authority = LocalApprovalAuthority.create({ issuer: 'RUNTIME-AUTHORITY', keyId: 'ARTIFACT-KEY',
      now: () => new Date('2026-07-22T00:00:00.000Z'), approvalIdentities: [],
      authenticateApproverSession: () => undefined })
    const open = () => RuntimeFullPlaywrightCheckpointStore.open({ statePath: join(root, 'terminal.sqlite'),
      forbiddenRoots: [process.cwd()], now: () => new Date('2026-07-22T00:00:00.000Z'),
      signDigest: (digest) => authority.signArtifactDigest(digest),
      artifactAuthority: { material: authority.artifactVerifierMaterial,
        expectedPublicKeyDigest: authority.artifactVerifierMaterial.publicKeyDigest } })
    const first = open()
    const stored = await first.put({ attemptId: 'ATTEMPT-1', terminalIntentDigest: d('terminal'),
      bindingDigest: d('binding'), terminal: 'unknown', recovery: { phase: 'sign', reservationId: 'RES-1' } })
    first.close()

    const restarted = open()
    expect(await restarted.find('ATTEMPT-1', d('binding'))).toEqual(stored)
    expect(createArtifactSignatureVerifier(authority.artifactVerifierMaterial,
      authority.artifactVerifierMaterial.publicKeyDigest)(stored.receipt.signature)).toBe(true)
    await expect(restarted.put({ attemptId: 'ATTEMPT-1', terminalIntentDigest: d('other-terminal'),
      bindingDigest: d('binding'), terminal: 'unknown', recovery: { phase: 'sign' } }))
      .rejects.toThrow(/CHECKPOINT_CONFLICT/)
    await expect(restarted.put({ attemptId: 'ATTEMPT-2', terminalIntentDigest: d('terminal-2'),
      bindingDigest: d('binding-2'), terminal: 'unknown', recovery: { blob: 'x'.repeat(600 * 1024) } }))
      .rejects.toThrow(/CHECKPOINT_SIZE/)
    restarted.close()
  })

  test('有界 GC 保留未恢复 terminal intent，并回收最老 completed', async () => {
    const root = await mkdtemp(join(tmpdir(), 'full-checkpoint-gc-')); paths.push(root)
    const authority = LocalApprovalAuthority.create({ issuer: 'RUNTIME-AUTHORITY', keyId: 'ARTIFACT-KEY',
      now: () => new Date('2026-07-22T00:00:00.000Z'), approvalIdentities: [],
      authenticateApproverSession: () => undefined })
    let tick = 0
    const store = RuntimeFullPlaywrightCheckpointStore.open({ statePath: join(root, 'terminal.sqlite'),
      forbiddenRoots: [process.cwd()], now: () => new Date(1_800_000_000_000 + tick++), maxEntries: 3,
      signDigest: (digest) => authority.signArtifactDigest(digest),
      artifactAuthority: { material: authority.artifactVerifierMaterial,
        expectedPublicKeyDigest: authority.artifactVerifierMaterial.publicKeyDigest } })
    await store.put({ attemptId: 'A-1', terminalIntentDigest: d('t1'), bindingDigest: d('b1'),
      terminal: 'completed', recovery: { phase: 'done' } })
    await store.put({ attemptId: 'A-2', terminalIntentDigest: d('t2'), bindingDigest: d('b2'),
      terminal: 'unknown', recovery: { phase: 'unknown' } })
    await store.put({ attemptId: 'A-3', terminalIntentDigest: d('t3'), bindingDigest: d('b3'),
      terminal: 'completed', recovery: { phase: 'done' } })
    await store.put({ attemptId: 'A-4', terminalIntentDigest: d('t4'), bindingDigest: d('b4'),
      terminal: 'terminal-failed', recovery: { phase: 'release' } })
    expect(await store.find('A-1', d('b1'))).toBeUndefined()
    expect(await store.find('A-2', d('b2'))).toBeDefined()
    expect(await store.list()).toHaveLength(3)
    store.close()
  })

  test('terminal-failed checkpoint 可在重启后原子推进为 completed，且保留完整恢复材料', async () => {
    const root = await mkdtemp(join(tmpdir(), 'full-checkpoint-transition-')); paths.push(root)
    const authority = LocalApprovalAuthority.create({ issuer: 'RUNTIME-AUTHORITY', keyId: 'ARTIFACT-KEY',
      now: () => new Date('2026-07-22T00:00:00.000Z'), approvalIdentities: [],
      authenticateApproverSession: () => undefined })
    const open = () => RuntimeFullPlaywrightCheckpointStore.open({ statePath: join(root, 'terminal.sqlite'),
      forbiddenRoots: [process.cwd()], now: () => new Date('2026-07-22T00:00:00.000Z'),
      signDigest: (digest) => authority.signArtifactDigest(digest),
      artifactAuthority: { material: authority.artifactVerifierMaterial,
        expectedPublicKeyDigest: authority.artifactVerifierMaterial.publicKeyDigest } })
    const failed = open()
    await failed.put({ attemptId: 'ATTEMPT-RECOVER', terminalIntentDigest: d('terminal'),
      bindingDigest: d('binding'), terminal: 'terminal-failed',
      recovery: { phase: 'complete', reservationId: 'RES-1', outcomeReceiptDigest: d('outcome') } })
    failed.close()

    const restarted = open()
    const completed = await restarted.put({ attemptId: 'ATTEMPT-RECOVER',
      terminalIntentDigest: d('terminal'), bindingDigest: d('binding'), terminal: 'completed',
      recovery: { phase: 'completed', reservationId: 'RES-1', outcomeReceiptDigest: d('outcome'),
        authorityReceiptDigest: d('authority'), gatewayAuditDigest: d('gateway'),
        evidence: [{ evidenceId: 'SCREENSHOT', digest: d('png'), byteLength: 123 }],
        finalizationFacts: { schemaVersion: '1.0.0', result: 'passed' },
        browserMeasurements: [{ measurementId: 'M-1', digest: d('measurement') }] } })
    expect(completed.revision).toBe(2)
    expect((await restarted.find('ATTEMPT-RECOVER', d('binding')))?.terminal).toBe('completed')
    expect((await restarted.list())[0]?.recovery).toEqual(completed.recovery)
    restarted.close()
  })

  test('重启时固定 Artifact Authority 公钥并拒绝 key swap', async () => {
    const root = await mkdtemp(join(tmpdir(), 'full-checkpoint-key-swap-')); paths.push(root)
    const firstAuthority = LocalApprovalAuthority.create({ issuer: 'RUNTIME-AUTHORITY', keyId: 'KEY-1',
      now: () => new Date('2026-07-22T00:00:00.000Z'), approvalIdentities: [],
      authenticateApproverSession: () => undefined })
    const first = RuntimeFullPlaywrightCheckpointStore.open({ statePath: join(root, 'terminal.sqlite'),
      forbiddenRoots: [process.cwd()], signDigest: (digest) => firstAuthority.signArtifactDigest(digest),
      artifactAuthority: { material: firstAuthority.artifactVerifierMaterial,
        expectedPublicKeyDigest: firstAuthority.artifactVerifierMaterial.publicKeyDigest } })
    await first.put({ attemptId: 'ATTEMPT-1', terminalIntentDigest: d('terminal'),
      bindingDigest: d('binding'), terminal: 'terminal-failed', recovery: { phase: 'release' } })
    first.close()

    const swappedAuthority = LocalApprovalAuthority.create({ issuer: 'RUNTIME-AUTHORITY', keyId: 'KEY-2',
      now: () => new Date('2026-07-22T00:00:00.000Z'), approvalIdentities: [],
      authenticateApproverSession: () => undefined })
    expect(() => RuntimeFullPlaywrightCheckpointStore.open({ statePath: join(root, 'terminal.sqlite'),
      forbiddenRoots: [process.cwd()], signDigest: (digest) => swappedAuthority.signArtifactDigest(digest),
      artifactAuthority: { material: swappedAuthority.artifactVerifierMaterial,
        expectedPublicKeyDigest: swappedAuthority.artifactVerifierMaterial.publicKeyDigest } }))
      .toThrow(/CHECKPOINT_AUTHORITY_MISMATCH|CHECKPOINT_SIGNATURE_INVALID/)
  })

  test('五个 terminal stage 每阶段崩溃重启都保留同 intent 并单调推进 revision', async () => {
    const root = await mkdtemp(join(tmpdir(), 'full-checkpoint-five-stage-')); paths.push(root)
    const authority = LocalApprovalAuthority.create({ issuer: 'RUNTIME-AUTHORITY', keyId: 'ARTIFACT-KEY',
      now: () => new Date('2026-07-22T00:00:00.000Z'), approvalIdentities: [],
      authenticateApproverSession: () => undefined })
    const open = () => RuntimeFullPlaywrightCheckpointStore.open({ statePath: join(root, 'terminal.sqlite'),
      forbiddenRoots: [process.cwd()], signDigest: (digest) => authority.signArtifactDigest(digest),
      artifactAuthority: { material: authority.artifactVerifierMaterial,
        expectedPublicKeyDigest: authority.artifactVerifierMaterial.publicKeyDigest } })
    const stages = ['reserved', 'lease-terminal-intent', 'write-terminal-intent',
      'authority-terminal', 'published']
    for (const [index, phase] of stages.entries()) {
      const process = open()
      const checkpoint = await process.put({ attemptId: 'ATTEMPT-STAGES', terminalIntentDigest: d('terminal'),
        bindingDigest: d('binding'), terminal: 'terminal-failed',
        recovery: { phase, replayInputDigest: d(phase) } })
      expect(checkpoint.revision).toBe(index + 1)
      process.close()
    }
    const recoveryProcess = open()
    const terminal = await recoveryProcess.put({ attemptId: 'ATTEMPT-STAGES', terminalIntentDigest: d('terminal'),
      bindingDigest: d('binding'), terminal: 'completed',
      recovery: { phase: 'recovered-completed', output: { resultDigest: d('result') } } })
    expect(terminal.revision).toBe(6)
    recoveryProcess.close()
  })

  test('已签 receipt 被落盘篡改后在 reopen 时拒绝，不信任 checkpoint 自带 key/signature', async () => {
    const root = await mkdtemp(join(tmpdir(), 'full-checkpoint-forgery-')); paths.push(root)
    const statePath = join(root, 'terminal.sqlite')
    const authority = LocalApprovalAuthority.create({ issuer: 'RUNTIME-AUTHORITY', keyId: 'ARTIFACT-KEY',
      now: () => new Date('2026-07-22T00:00:00.000Z'), approvalIdentities: [],
      authenticateApproverSession: () => undefined })
    const input = { statePath, forbiddenRoots: [process.cwd()],
      signDigest: (digest: string) => authority.signArtifactDigest(digest),
      artifactAuthority: { material: authority.artifactVerifierMaterial,
        expectedPublicKeyDigest: authority.artifactVerifierMaterial.publicKeyDigest } }
    const first = RuntimeFullPlaywrightCheckpointStore.open(input)
    await first.put({ attemptId: 'ATTEMPT-FORGE', terminalIntentDigest: d('terminal'),
      bindingDigest: d('binding'), terminal: 'terminal-failed', recovery: { phase: 'reserved' } })
    first.close()
    const raw = new SqliteSnapshotStore(statePath, 'runtime-full-playwright-terminal/v1', {
      forbiddenRoots: [process.cwd()],
    })
    await raw.runExclusive(async () => {
      const snapshot = JSON.parse(raw.begin())
      snapshot.entries[0].receipt.signature.signature = 'forged-signature'
      raw.commit(canonicalizeJson(snapshot))
    })
    raw.close()
    expect(() => RuntimeFullPlaywrightCheckpointStore.open(input)).toThrow(/CHECKPOINT_SIGNATURE_INVALID/)
  })
})
