import { describe, expect, test } from 'vitest'
import type { RuntimeRunSnapshot } from '../src/run-store.js'
import { assertRunHandle, createRunHandle } from '../src/run-handle.js'

const d = (value: string): string => `sha256:${value.repeat(64)}`

describe('RunHandle', () => {
  test('由 Runtime 唯一生成并闭合 asset、run、revision 与 generation', () => {
    const snapshot = fixture()
    const handle = createRunHandle(snapshot)

    expect(handle).toEqual({
      assetId: 'ASSET-1', runId: 'RUN-1', revision: 4,
      generationDigest: expect.stringMatching(/^sha256:/),
    })
    expect(assertRunHandle(snapshot, handle)).toEqual(handle)
    expect(createRunHandle(snapshot)).toEqual(handle)
  })

  test.each([
    ['assetId', 'ASSET-2'], ['runId', 'RUN-2'], ['revision', 3], ['generationDigest', d('f')],
  ] as const)('拒绝混用陈旧或跨 Run handle: %s', (field, value) => {
    const snapshot = fixture()
    const handle = { ...createRunHandle(snapshot), [field]: value }
    expect(() => assertRunHandle(snapshot, handle)).toThrowError(expect.objectContaining({
      code: field === 'revision' ? 'E2E_RUN_HANDLE_REVISION_STALE' : 'E2E_RUN_HANDLE_BINDING_MISMATCH',
    }))
  })
})

function fixture(): RuntimeRunSnapshot {
  return {
    schemaVersion: '1.8.0', runId: 'RUN-1', assetId: 'ASSET-1',
    projectIdentityDigest: d('1'), runtimeInstallationDigest: d('2'), runRevision: 4,
    workflow: { current: 'created', sequence: 0, eventChainDigest: d('3') },
    artifactDigests: { 'prd-source': d('4') }, frozenArtifacts: {}, trustedExecutionFacts: {},
    writeAttempts: {}, executionResults: { readEnvironment: {}, realEnvironment: {}, gatewayInjection: {} },
    requestResponses: {}, createdAt: '2026-08-02T00:00:00.000Z', updatedAt: '2026-08-02T00:00:00.000Z',
  }
}
