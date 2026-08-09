import { describe, expect, test } from 'vitest'
import { createRegistryGoldenArtifact } from '../src/registry-golden-proof.js'

const D = `sha256:${'3'.repeat(64)}`
const result = { ok: true, mode: 'registry', skippedTests: 0, packageSource: 'npm-registry' }

describe('Registry Golden stable proof', () => {
  test('只接受 Linux/macOS 与 Node 22/24 四格全绿的 Registry 结果', () => {
    const proof = createRegistryGoldenArtifact({ runtimeVersion: '0.7.0', installationDigest: D,
      sourceCommit: 'a'.repeat(40), results: matrix(result) })
    expect(proof).toMatchObject({ passed: true, gateEligible: true, packageCount: 14,
      matrix: expect.arrayContaining([expect.objectContaining({
        platform: 'darwin', arch: 'arm64', nodeMajor: 22, passed: true,
      })]) })
  })
  test('拒绝跳过、workspace tarball 或缺失矩阵，不允许冒充发布后 Golden', () => {
    expect(() => createRegistryGoldenArtifact({ runtimeVersion: '0.7.0', installationDigest: D,
      sourceCommit: 'a'.repeat(40), results: matrix({ ...result, skippedTests: 1 }) }))
      .toThrow(/E2E_REGISTRY_GOLDEN_RESULT_INVALID/)
    expect(() => createRegistryGoldenArtifact({ runtimeVersion: '0.7.0', installationDigest: D,
      sourceCommit: 'a'.repeat(40), results: matrix(result).slice(1) }))
      .toThrow(/E2E_REGISTRY_GOLDEN_MATRIX_INCOMPLETE/)
  })
})

function matrix(golden: unknown) {
  return [
    { platform: 'darwin' as const, arch: 'arm64' as const, nodeMajor: 22 as const, result: golden },
    { platform: 'darwin' as const, arch: 'arm64' as const, nodeMajor: 24 as const, result: golden },
    { platform: 'linux' as const, arch: 'x64' as const, nodeMajor: 22 as const, result: golden },
    { platform: 'linux' as const, arch: 'x64' as const, nodeMajor: 24 as const, result: golden },
  ]
}
