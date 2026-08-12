import { describe, expect, test } from 'vitest'
import { runChromeIsolationProof } from './e2e-run-isolation-proof.js'

describe('真实 Chrome Run 隔离 proof', () => {
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
