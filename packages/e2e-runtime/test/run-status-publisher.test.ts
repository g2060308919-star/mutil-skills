import { stat, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { createRuntimeTestRoots } from './fixtures.js'
import { RunStatusPublisher } from '../src/run-status-publisher.js'
import { RuntimeStatusResultSchema } from '@mutil-skills/e2e-contracts'

const d = (value: string): string => `sha256:${value.repeat(64)}`

describe('RunStatusPublisher', () => {
  test('原子写入私有 JSON/Markdown/HTML 状态工作区', async () => {
    const roots = await createRuntimeTestRoots()
    const publisher = new RunStatusPublisher({ homeDir: roots.home })
    const output = await publisher.publish(statusFixture())

    expect(output).toBe(join(roots.home, '.mutil-skills', 'e2e', 'runs', 'ASSET-1', 'RUN-1'))
    expect(JSON.parse(await readFile(join(output, 'run-status.json'), 'utf8'))).toMatchObject({
      runId: 'RUN-1', condition: { kind: 'ready' },
    })
    expect(await readFile(join(output, 'run-status.md'), 'utf8')).toContain('中间状态')
    expect(await readFile(join(output, 'run-status.html'), 'utf8')).toContain('<!doctype html>')
    expect((await stat(output)).mode & 0o777).toBe(0o700)
    expect((await stat(join(output, 'run-status.json'))).mode & 0o777).toBe(0o600)
    await expect(publisher.publish(statusFixture())).resolves.toBe(output)
  })
})

function statusFixture() {
  return RuntimeStatusResultSchema.parse({
    runId: 'RUN-1', assetId: 'ASSET-1', projectIdentityDigest: d('1'),
    runtimeInstallationDigest: d('2'), generationId: 'RUN-1', prdRevision: d('3'),
    workflow: { current: 'created', sequence: 0, eventChainDigest: d('4') },
    artifactDigests: { 'prd-source': d('3') }, state: 'created',
    nextEdge: { command: 'prepare-prd-understanding', from: 'created', expectedState: 'created' },
    verifiedDigests: { runtimeInstallation: d('2'), workflowEventChain: d('4') },
    minimumMissingInput: ['prd-understanding-prepared'],
    handle: { assetId: 'ASSET-1', runId: 'RUN-1', revision: 0, generationDigest: d('5') },
    stage: 'requirements', condition: { kind: 'ready' },
    preservedAssets: ['prd-source'], invalidatedAssets: [], semanticCases: [], remediation: [],
  })
}
