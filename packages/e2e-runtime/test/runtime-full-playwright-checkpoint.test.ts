import { afterEach, describe, expect, test } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LocalApprovalAuthority, createArtifactSignatureVerifier } from '@mutil-skills/e2e-authority'
import { digestText } from '@mutil-skills/e2e-contracts'
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
      signDigest: (digest) => authority.signArtifactDigest(digest) })
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
      signDigest: (digest) => authority.signArtifactDigest(digest) })
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
})
