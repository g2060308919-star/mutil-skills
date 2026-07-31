import { EncryptedQuarantine, InMemoryQuarantineAuditLog } from '@mutil-skills/e2e-engine'
import { access, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { RuntimeQuarantineSecretProvider } from '../src/quarantine-secret-provider.js'
import {
  createProductionEvidenceQuarantine,
  quarantineRuntimeEvidence,
} from '../src/runtime-evidence-quarantine.js'
import { runtimeLayout } from '../src/runtime-layout.js'
import { createRuntimeTestRoots } from './fixtures.js'

describe('production evidence quarantine integration', () => {
  test('使用真实 Runtime 主密钥把截图与 DOM 加密写到项目外', async () => {
    const roots = await createRuntimeTestRoots()
    const provider = await RuntimeQuarantineSecretProvider.createForProject({
      homeDir: roots.home,
      projectRoot: roots.project,
    })
    const quarantine = new EncryptedQuarantine({
      root: runtimeLayout(roots.home).quarantine,
      secrets: provider,
      audit: new InMemoryQuarantineAuditLog(),
      now: () => new Date('2026-07-20T00:00:00.000Z'),
    })
    const screenshot = Uint8Array.from([137, 80, 78, 71])
    const dom = Buffer.from('{"format":"dom-tree/1","roots":[]}', 'utf8')

    const facts = await quarantineRuntimeEvidence(
      createProductionEvidenceQuarantine({ quarantine }),
      { runId: 'RUN-QUARANTINE-INTEGRATION', attemptId: 'ATTEMPT-1', evidence: { screenshot, dom } },
    )

    expect(facts.records).toHaveLength(2)
    const root = join(runtimeLayout(roots.home).quarantine, facts.runId)
    await expect(access(join(root, 'key-envelope.json'))).resolves.toBeUndefined()
    const manifest = await readFile(join(root, 'manifest.json'), 'utf8')
    expect(manifest).not.toContain(Buffer.from(screenshot).toString('base64'))
    expect(manifest).not.toContain(dom.toString('utf8'))
    provider.close()
  })

  test('同一 Run 可按 attempt 追加多 Case 证据且精确重放保持幂等', async () => {
    const roots = await createRuntimeTestRoots()
    const provider = await RuntimeQuarantineSecretProvider.createForProject({
      homeDir: roots.home,
      projectRoot: roots.project,
    })
    const quarantine = new EncryptedQuarantine({
      root: runtimeLayout(roots.home).quarantine,
      secrets: provider,
      audit: new InMemoryQuarantineAuditLog(),
      now: () => new Date('2026-07-20T00:00:00.000Z'),
    })
    const capability = createProductionEvidenceQuarantine({ quarantine })
    const firstEvidence = {
      screenshot: Uint8Array.from([137, 80, 78, 71, 1]),
      dom: Buffer.from('{"case":1}', 'utf8'),
    }
    const secondEvidence = {
      screenshot: Uint8Array.from([137, 80, 78, 71, 2]),
      dom: Buffer.from('{"case":2}', 'utf8'),
    }

    const first = await quarantineRuntimeEvidence(capability, {
      runId: 'RUN-MULTI-CASE',
      attemptId: 'ATTEMPT-1',
      evidence: firstEvidence,
    })
    const second = await quarantineRuntimeEvidence(capability, {
      runId: 'RUN-MULTI-CASE',
      attemptId: 'ATTEMPT-2',
      evidence: secondEvidence,
    })
    const replay = await quarantineRuntimeEvidence(capability, {
      runId: 'RUN-MULTI-CASE',
      attemptId: 'ATTEMPT-2',
      evidence: secondEvidence,
    })

    expect(second.records.map(({ quarantinePath }) => quarantinePath)).toEqual([
      'raw/ATTEMPT-2/screenshot.bin',
      'raw/ATTEMPT-2/dom.bin',
    ])
    expect(replay).toEqual(second)
    const manifest = JSON.parse(await readFile(
      join(runtimeLayout(roots.home).quarantine, first.runId, 'manifest.json'),
      'utf8',
    )) as { files: unknown[] }
    expect(manifest.files).toHaveLength(4)
    provider.close()
  })
})
