import { describe, expect, test, vi } from 'vitest'
import { digestText } from '@mutil-skills/e2e-contracts'
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
      reserveCapability: async () => ({ reservationId: 'RES-1' } as never),
      capture: async () => [], retireProgram: async () => undefined, retireCleanup: async () => undefined,
      observeEffect: () => 'applied', freezeGateway: async () => ({ executionSessionId: 'GW-1',
        policyDigest: d('policy'), summary: { received: 1, forwarded: 1, blocked: 0, byIntent: {} } }),
      publishGateway: async () => ({ auditDigest: d('audit') }),
      terminal: { releaseLease: async () => d('release'), quarantineLease: async () => d('quarantine'),
        finalizeWriteOutcome: async () => ({ outcome: {} as never, authorityReceiptDigest: d('complete') }),
        markWriteUnknownWithOutcome: async () => ({ outcome: {} as never, authorityReceiptDigest: d('unknown') }),
        markWriteUnknown: async () => d('unknown') },
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
      reserveCapability: async () => ({ reservationId: 'RES-1' } as never),
      capture: async () => [], retireProgram: async () => undefined, retireCleanup: async () => undefined,
      observeEffect: () => 'unknown', freezeGateway: async () => { throw new Error('unused') },
      publishGateway: async () => { throw new Error('unused') }, terminal: {
        releaseLease: async () => d('release'), quarantineLease: async () => d('quarantine'),
        finalizeWriteOutcome: async () => { throw new Error('unused') },
        markWriteUnknownWithOutcome: async () => { throw new Error('unused') },
        markWriteUnknown: async () => d('unknown'),
      },
    })).toThrow(/ASSEMBLY_INVALID/)
  })

  test('page/context/browser/browserType 全对象图不能逃逸到 raw Browser lifecycle', async () => {
    const close = vi.fn()
    const launch = vi.fn(async () => rawBrowser)
    const rawBrowserType = { launch, launchPersistentContext: launch, connect: launch, connectOverCDP: launch }
    const rawBrowser: any = { close, browserType: () => rawBrowserType,
      contexts: () => [rawContext], newContext: async () => rawChildContext }
    const rawContext: any = { browser: () => rawBrowser, pages: () => [rawPage],
      newPage: async () => rawPage, waitForEvent: async () => rawPage, newCDPSession: async () => ({}) }
    const rawPage: any = { context: () => rawContext, opener: async () => rawPage }
    const rawChildContext: any = { browser: () => rawBrowser, pages: () => [],
      newPage: async () => rawChildPage, newCDPSession: async () => ({}) }
    const rawChildPage: any = { context: () => rawChildContext, opener: async () => rawPage }
    const cleanupBrowser = { close() {}, contexts: () => [], browserType: () => rawBrowserType }
    const state = Object.create(null) as Record<string, unknown>
    const assembled = createRuntimeHostFullPlaywrightSession({
      authorityRpcPublicKeyDigest: d('authority-key'), binding: binding(),
      programBindings: { page: rawPage, context: rawContext, browser: rawBrowser,
        request: {}, expect: {}, testInfo: {}, state },
      cleanupBindings: { page: {}, context: {}, browser: cleanupBrowser,
        request: {}, expect: {}, testInfo: {}, state },
      reserveCapability: async () => ({ reservationId: 'RES-1' } as never),
      capture: async () => [], retireProgram: async () => undefined, retireCleanup: async () => undefined,
      observeEffect: () => 'applied', freezeGateway: async () => ({ executionSessionId: 'GW-1',
        policyDigest: d('policy'), summary: { received: 0, forwarded: 0, blocked: 0, byIntent: {} } }),
      publishGateway: async () => ({ auditDigest: d('audit') }), terminal: {
        releaseLease: async () => d('release'), quarantineLease: async () => d('quarantine'),
        finalizeWriteOutcome: async () => ({ outcome: {} as never, authorityReceiptDigest: d('complete') }),
        markWriteUnknownWithOutcome: async () => ({ outcome: {} as never, authorityReceiptDigest: d('unknown') }),
        markWriteUnknown: async () => d('unknown'),
      },
    })
    const program = getFullPlaywrightControlledSession(assembled.session)!.programBindings as any
    expect(program.page.context()).toBe(program.context)
    expect(program.context.browser()).toBe(program.browser)
    expect(program.browser.contexts()).toEqual([program.context])
    expect(program.page.context().browser().close).toBeUndefined()
    expect(program.context.newCDPSession).toBeUndefined()
    await expect(program.browser.browserType().launch()).rejects.toThrow(/BROWSER_LIFECYCLE_FORBIDDEN/)
    const childContext = await program.browser.newContext()
    const childPage = await childContext.newPage()
    expect(childContext.browser()).toBe(program.browser)
    expect(childPage.context()).toBe(childContext)
    expect((await childPage.opener()).context()).toBe(program.context)
    expect(childContext.newCDPSession).toBeUndefined()
    expect(close).not.toHaveBeenCalled()
    expect(launch).not.toHaveBeenCalled()
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
