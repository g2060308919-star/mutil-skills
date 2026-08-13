import { describe, expect, test } from 'vitest'
import { runChromeIsolationProof } from './e2e-run-isolation-proof.js'

const loopbackAvailable = await canBindLoopback()
if (process.env.E2E_REQUIRED_TEST_CAPABILITIES?.split(',').includes('loopback') && !loopbackAvailable) {
  throw new Error('E2E_HOST_CAPABILITY_NOT_EXECUTED:loopback')
}

describe.skipIf(!loopbackAvailable)('真实 Chrome Run 隔离 proof（无 loopback 时不计功能通过）', () => {
  test('连续 Run 隔离 cookie/storage/service worker/download 并删除一次性 Profile', async () => {
    const proof = await runChromeIsolationProof()
    expect(proof).toMatchObject({
      schemaVersion: 'chrome-run-isolation-proof/v1', passed: true,
      claims: {
        browserProductIsolation: 'verified', backendAccountIsolation: 'not-executed',
      },
      observations: {
        cookieCrossRead: false, localStorageCrossRead: false, sessionStorageCrossRead: false,
        indexedDbCrossRead: false, cacheCrossRead: false, serviceWorkerCrossRead: false,
        downloadCrossRead: false, profilesRemoved: true,
      },
    })
  }, 30_000)
})

async function canBindLoopback(): Promise<boolean> {
  const { createServer } = await import('node:http')
  const server = createServer()
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject); server.listen(0, '127.0.0.1', resolve)
    })
    return true
  } catch (error) {
    if (error instanceof Error && 'code' in error && ['EACCES', 'EPERM'].includes(String(error.code))) return false
    throw error
  } finally {
    if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()))
  }
}
