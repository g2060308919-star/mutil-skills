import { describe, expect, test, vi } from 'vitest'
import { digestText, type ExecutionOutcomeBinding } from '@mutil-skills/e2e-contracts'
import {
  createRuntimeHostFullPlaywrightSession,
  getWriteRuntimeSessionBinding,
} from '../src/index.js'
import { getFullPlaywrightControlledSession } from '../src/full-playwright-session-internal.js'

const d = (value: string) => digestText('runtime-host-full-session-test/v1', value)

describe('Runtime Host full Playwright production assembly', () => {
  test('program/cleanup 使用不同 Browser lifecycle，approved source 看不到 close', () => {
    const programClose = vi.fn()
    const cleanupClose = vi.fn()
    const state = Object.create(null) as Record<string, unknown>
    const assembled = createRuntimeHostFullPlaywrightSession({
      authorityRpcPublicKeyDigest: d('authority-key'), binding: binding(),
      programBindings: { page: {}, context: {}, browser: { close: programClose, newContext() {} },
        request: {}, expect: {}, testInfo: {}, state },
      cleanupBindings: { page: {}, context: {}, browser: { close: cleanupClose, newContext() {} },
        request: {}, expect: {}, testInfo: {}, state },
      capture: async () => [], retireProgram: async () => undefined, retireCleanup: async () => undefined,
      observeEffect: () => 'applied', finalizeGateway: async () => ({ executionSessionId: 'GW-1',
        policyDigest: d('policy'), summary: { received: 1, forwarded: 1, blocked: 0, byIntent: {} },
        auditDigest: d('audit') }),
      issueOutcome: (value: ExecutionOutcomeBinding) => ({ ...value, issuer: 'GW', keyId: 'KEY',
        purpose: 'execution-outcome-receipt/v1', algorithm: 'Ed25519', signedDigest: d('outcome'), signature: 'sig' }),
      terminal: { releaseLease: async () => d('release'), quarantineLease: async () => d('quarantine'),
        completeReservation: async () => d('complete'), markReservationUnknown: async () => d('unknown') },
    })
    const backend = getFullPlaywrightControlledSession(assembled.session)!
    expect(backend.programBindings.browser).not.toBe(backend.cleanupBindings.browser)
    expect((backend.programBindings.browser as { close?: unknown }).close).toBeUndefined()
    expect((backend.cleanupBindings.browser as { close?: unknown }).close).toBeUndefined()
    expect(programClose).not.toHaveBeenCalled()
    expect(cleanupClose).not.toHaveBeenCalled()
    expect(getWriteRuntimeSessionBinding(assembled.runtime)).toMatchObject({ mode: 'trusted-compiler',
      authorityTransport: 'authenticated-rpc', authorityRpcPublicKeyDigest: d('authority-key'),
      sourceDigest: d('source-set') })
  })

  test('同一底层 Browser 不能伪装成两个 lifecycle', () => {
    const browser = { close() {} }
    const state = {}
    expect(() => createRuntimeHostFullPlaywrightSession({
      authorityRpcPublicKeyDigest: d('authority-key'), binding: binding(),
      programBindings: { page: {}, context: {}, browser, request: {}, expect: {}, testInfo: {}, state },
      cleanupBindings: { page: {}, context: {}, browser, request: {}, expect: {}, testInfo: {}, state },
      capture: async () => [], retireProgram: async () => undefined, retireCleanup: async () => undefined,
      observeEffect: () => 'unknown', finalizeGateway: async () => { throw new Error('unused') },
      issueOutcome: () => { throw new Error('unused') }, terminal: {
        releaseLease: async () => d('release'), quarantineLease: async () => d('quarantine'),
        completeReservation: async () => d('complete'), markReservationUnknown: async () => d('unknown'),
      },
    })).toThrow(/ASSEMBLY_INVALID/)
  })
})

function binding() {
  return { executionProfile: 'full-playwright' as const, assetId: 'ASSET-1', generationId: 'GEN-1',
    prdRevision: d('prd'), runId: 'RUN-1', caseId: 'CASE-1', stepId: 'STEP-1', actionId: 'ACTION-1',
    capabilityId: 'CAP-1', programDigest: d('program'), cleanupProgramDigest: d('cleanup'),
    cleanupPlanDigest: d('plan'), leaseId: 'LEASE-1', fencingToken: 1, targetFingerprint: d('target'),
    approvedRequestSetDigest: d('requests'), gatewayPolicyDigest: d('policy'), executionSessionId: 'GW-1',
    sourceSetDigest: d('source-set'), programBrowserSessionId: 'BROWSER-PROGRAM-1',
    cleanupBrowserSessionId: 'BROWSER-CLEANUP-1' }
}
