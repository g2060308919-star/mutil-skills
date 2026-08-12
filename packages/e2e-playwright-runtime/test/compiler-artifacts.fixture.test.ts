import { describe, expect, test, vi } from 'vitest'

describe('compilerArtifactVerification', () => {
  test('正向工具链证明跟随当前 Node patch，而不是冻结开发机版本', async () => {
    const descriptor = Object.getOwnPropertyDescriptor(process.versions, 'node')
    Object.defineProperty(process.versions, 'node', {
      ...descriptor,
      value: '24.18.1',
    })

    try {
      vi.resetModules()
      const fixture = await import('./compiler-artifacts.fixture.js')
      expect(fixture.compilerArtifactVerification.nodeVersion).toBe('24.18.1')
    } finally {
      if (descriptor) Object.defineProperty(process.versions, 'node', descriptor)
      vi.resetModules()
    }
  })
})
