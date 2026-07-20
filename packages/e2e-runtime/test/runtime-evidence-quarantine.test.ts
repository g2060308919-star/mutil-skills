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
})
