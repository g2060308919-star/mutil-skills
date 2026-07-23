import type {
  ControlledFullPlaywrightSession,
  ControlledFullPlaywrightSessionBinding,
  FullPlaywrightBindings,
  FullPlaywrightEvidenceStage,
  FullPlaywrightEvidenceSummary,
  FullPlaywrightGatewayObservation,
  FullPlaywrightGatewayTerminalResult,
  FullPlaywrightTerminalOutcomeInput,
} from './full-playwright-runner.js'
import type { CapabilityReservation } from '@mutil-skills/e2e-contracts'

export interface FullPlaywrightControlledSessionBackend {
  binding: ControlledFullPlaywrightSessionBinding
  programBindings: FullPlaywrightBindings
  cleanupBindings: FullPlaywrightBindings
  reserveCapability(): Promise<CapabilityReservation>
  capture(stage: FullPlaywrightEvidenceStage): Promise<FullPlaywrightEvidenceSummary[]>
  retireProgram(): Promise<void>
  retireCleanup(): Promise<void>
  observeEffect(): 'proven-not-applied' | 'applied' | 'unknown'
  freezeGateway(): Promise<FullPlaywrightGatewayObservation>
  publishGateway(): Promise<{ auditDigest: string }>
  checkpoint?(stage: 'reserved' | 'lease-terminal-intent' | 'write-terminal-intent'
    | 'authority-terminal' | 'published', material: Record<string, unknown>): Promise<void>
  terminal: {
    releaseLease(input: { leaseId: string; fencingToken: number; targetFingerprint: string;
      cleanupDigest: string }): Promise<string>
    quarantineLease(input: { leaseId: string; fencingToken: number; targetFingerprint: string;
      reason: string }): Promise<string>
    finalizeWriteOutcome(input: FullPlaywrightTerminalOutcomeInput): Promise<FullPlaywrightGatewayTerminalResult>
    markWriteUnknownWithOutcome(input: FullPlaywrightTerminalOutcomeInput,
      observation: string): Promise<FullPlaywrightGatewayTerminalResult>
    markWriteUnknown(observation: string): Promise<string>
  }
}

const controlledSessions = new WeakMap<object, FullPlaywrightControlledSessionBackend>()
const browserFacades = new WeakMap<object, { browserSessionId: string; gatewaySessionId: string;
  lifecycle: 'program' | 'cleanup' }>()

/** Internal launcher seam: removes Browser.close and brands the independent lifecycle/gateway binding. */
export function createFullPlaywrightBrowserFacade<T extends object>(browser: T, binding: {
  browserSessionId: string
  gatewaySessionId: string
  lifecycle: 'program' | 'cleanup'
}): T {
  if (!browser || typeof browser !== 'object' || !binding.browserSessionId || !binding.gatewaySessionId) {
    throw new Error('E2E_FULL_PLAYWRIGHT_BROWSER_FACADE_INVALID')
  }
  const facade = new Proxy(browser, {
    get(target, property) {
      if (property === 'close') return undefined
      const value = Reflect.get(target, property, target)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
  browserFacades.set(facade, Object.freeze(structuredClone(binding)))
  return facade
}

/**
 * Closes every Browser-returning path in the Playwright object graph. The supplied objects may
 * already be Runtime Gateway proxies; this layer preserves them while ensuring approved source
 * can never recover their raw Browser, create an unwrapped context, or launch/connect a Browser.
 */
export function createFullPlaywrightBindingFacades(
  bindings: FullPlaywrightBindings,
  binding: { browserSessionId: string; gatewaySessionId: string; lifecycle: 'program' | 'cleanup' },
): FullPlaywrightBindings {
  if (!object(bindings.browser) || !object(bindings.context) || !object(bindings.page)) {
    throw new Error('E2E_FULL_PLAYWRIGHT_BINDING_GRAPH_INVALID')
  }
  const contexts = new WeakMap<object, object>()
  const pages = new WeakMap<object, object>()
  const browserTypes = new WeakMap<object, object>()
  let browserFacade: object

  const wrapBrowserType = (raw: object): object => {
    const existing = browserTypes.get(raw)
    if (existing) return existing
    const facade = new Proxy(raw, { get(target, property) {
      if (['launch', 'launchPersistentContext', 'connect', 'connectOverCDP'].includes(String(property))) {
        return async () => { throw new Error('E2E_FULL_PLAYWRIGHT_BROWSER_LIFECYCLE_FORBIDDEN') }
      }
      const value = Reflect.get(target, property, target)
      return typeof value === 'function' ? value.bind(target) : value
    } })
    browserTypes.set(raw, facade)
    return facade
  }
  const wrapPage = (raw: object): object => {
    const existing = pages.get(raw)
    if (existing) return existing
    const facade = new Proxy(raw, { get(target, property) {
      if (property === 'context') return () => wrapContext(objectCall(target, 'context'))
      if (property === 'opener') return async () => {
        const value = await objectAsyncCall(target, 'opener')
        return value === null ? null : wrapPage(value)
      }
      if (property === 'waitForEvent') return async (event: string, ...args: unknown[]) => {
        const value = await method(target, 'waitForEvent')(event, ...args)
        return event === 'popup' && object(value) ? wrapPage(value) : value
      }
      if (['on', 'once', 'addListener'].includes(String(property))) return (event: string,
        listener: (...args: unknown[]) => unknown) => method(target, String(property))(event,
          event === 'popup' ? (value: unknown, ...args: unknown[]) =>
            listener(object(value) ? wrapPage(value) : value, ...args) : listener)
      const value = Reflect.get(target, property, target)
      return typeof value === 'function' ? value.bind(target) : value
    } })
    pages.set(raw, facade)
    return facade
  }
  const wrapContext = (raw: object): object => {
    const existing = contexts.get(raw)
    if (existing) return existing
    const facade = new Proxy(raw, { get(target, property) {
      if (property === 'browser') return () => browserFacade
      if (property === 'close' || property === 'newCDPSession') return undefined
      if (property === 'newPage') return async (...args: unknown[]) =>
        wrapPage(await objectAsyncMethod(target, 'newPage', args))
      if (property === 'pages' || property === 'backgroundPages' || property === 'serviceWorkers') {
        return () => arrayCall(target, String(property)).map(wrapPage)
      }
      if (property === 'waitForEvent') return async (event: string, ...args: unknown[]) => {
        const value = await method(target, 'waitForEvent')(event, ...args)
        return event === 'page' && object(value) ? wrapPage(value) : value
      }
      if (['on', 'once', 'addListener'].includes(String(property))) return (event: string,
        listener: (...args: unknown[]) => unknown) => method(target, String(property))(event,
          event === 'page' ? (value: unknown, ...args: unknown[]) =>
            listener(object(value) ? wrapPage(value) : value, ...args) : listener)
      const value = Reflect.get(target, property, target)
      return typeof value === 'function' ? value.bind(target) : value
    } })
    contexts.set(raw, facade)
    return facade
  }
  const graphBrowser = new Proxy(bindings.browser as object, { get(target, property) {
    if (property === 'close' || property === 'newBrowserCDPSession') return undefined
    if (property === 'browserType') return () => wrapBrowserType(objectCall(target, 'browserType'))
    if (property === 'contexts') return () => arrayCall(target, 'contexts').map(wrapContext)
    if (property === 'newContext') return async (...args: unknown[]) =>
      wrapContext(await objectAsyncMethod(target, 'newContext', args))
    if (property === 'newPage') return async (...args: unknown[]) => {
      const context = await objectAsyncMethod(target, 'newContext', args)
      return wrapPage(await objectAsyncMethod(context, 'newPage', []))
    }
    const value = Reflect.get(target, property, target)
    return typeof value === 'function' ? value.bind(target) : value
  } })
  browserFacade = createFullPlaywrightBrowserFacade(graphBrowser, binding)
  return {
    ...bindings,
    browser: browserFacade,
    context: wrapContext(bindings.context as object),
    page: wrapPage(bindings.page as object),
  }
}

function object(value: unknown): value is object {
  return typeof value === 'object' && value !== null
}

function method(target: object, name: string): (...args: unknown[]) => unknown {
  const value = Reflect.get(target, name, target)
  if (typeof value !== 'function') throw new Error('E2E_FULL_PLAYWRIGHT_BINDING_GRAPH_INVALID')
  return value.bind(target) as (...args: unknown[]) => unknown
}

function objectCall(target: object, name: string): object {
  const value = method(target, name)()
  if (!object(value)) throw new Error('E2E_FULL_PLAYWRIGHT_BINDING_GRAPH_INVALID')
  return value
}

async function objectAsyncCall(target: object, name: string): Promise<object | null> {
  const value = await method(target, name)()
  if (value !== null && !object(value)) throw new Error('E2E_FULL_PLAYWRIGHT_BINDING_GRAPH_INVALID')
  return value
}

async function objectAsyncMethod(target: object, name: string, args: unknown[]): Promise<object> {
  const value = await method(target, name)(...args)
  if (!object(value)) throw new Error('E2E_FULL_PLAYWRIGHT_BINDING_GRAPH_INVALID')
  return value
}

function arrayCall(target: object, name: string): object[] {
  const value = method(target, name)()
  if (!Array.isArray(value) || value.some((item) => !object(item))) {
    throw new Error('E2E_FULL_PLAYWRIGHT_BINDING_GRAPH_INVALID')
  }
  return value as object[]
}

/** Runtime internal assembly seam. Package root intentionally does not export this capability issuer. */
export function authorizeFullPlaywrightControlledSession(
  backend: FullPlaywrightControlledSessionBackend,
): ControlledFullPlaywrightSession {
  validateControlledBackend(backend)
  const session = Object.freeze({})
  controlledSessions.set(session, Object.freeze({
    binding: Object.freeze(structuredClone(backend.binding)),
    programBindings: backend.programBindings,
    cleanupBindings: backend.cleanupBindings,
    reserveCapability: backend.reserveCapability.bind(backend),
    capture: backend.capture.bind(backend),
    retireProgram: backend.retireProgram.bind(backend),
    retireCleanup: backend.retireCleanup.bind(backend),
    observeEffect: backend.observeEffect.bind(backend),
    freezeGateway: backend.freezeGateway.bind(backend),
    publishGateway: backend.publishGateway.bind(backend),
    ...(backend.checkpoint === undefined ? {} : { checkpoint: backend.checkpoint.bind(backend) }),
    terminal: Object.freeze({
      releaseLease: backend.terminal.releaseLease.bind(backend.terminal),
      quarantineLease: backend.terminal.quarantineLease.bind(backend.terminal),
      finalizeWriteOutcome: backend.terminal.finalizeWriteOutcome.bind(backend.terminal),
      markWriteUnknownWithOutcome: backend.terminal.markWriteUnknownWithOutcome.bind(backend.terminal),
      markWriteUnknown: backend.terminal.markWriteUnknown.bind(backend.terminal),
    }),
  }))
  return session
}

export function getFullPlaywrightControlledSession(
  session: ControlledFullPlaywrightSession,
): FullPlaywrightControlledSessionBackend | undefined {
  return session && typeof session === 'object' ? controlledSessions.get(session as object) : undefined
}

function validateControlledBackend(backend: FullPlaywrightControlledSessionBackend): void {
  const programBrowser = backend && typeof backend.programBindings?.browser === 'object'
    && backend.programBindings.browser !== null ? browserFacades.get(backend.programBindings.browser) : undefined
  const cleanupBrowser = backend && typeof backend.cleanupBindings?.browser === 'object'
    && backend.cleanupBindings.browser !== null ? browserFacades.get(backend.cleanupBindings.browser) : undefined
  if (!backend || typeof backend !== 'object' || backend.binding.executionProfile !== 'full-playwright'
    || backend.programBindings === backend.cleanupBindings
    || backend.programBindings.context === backend.cleanupBindings.context
    || backend.programBindings.page === backend.cleanupBindings.page
    || backend.programBindings.browser === backend.cleanupBindings.browser
    || !programBrowser || !cleanupBrowser || programBrowser.lifecycle !== 'program'
    || cleanupBrowser.lifecycle !== 'cleanup'
    || programBrowser.browserSessionId !== backend.binding.programBrowserSessionId
    || cleanupBrowser.browserSessionId !== backend.binding.cleanupBrowserSessionId
    || programBrowser.browserSessionId === cleanupBrowser.browserSessionId
    || programBrowser.gatewaySessionId !== backend.binding.executionSessionId
    || cleanupBrowser.gatewaySessionId !== backend.binding.executionSessionId
    || !backend.terminal || !['releaseLease', 'quarantineLease', 'finalizeWriteOutcome',
      'markWriteUnknownWithOutcome', 'markWriteUnknown']
      .every((method) => typeof backend.terminal[method as keyof typeof backend.terminal] === 'function')
    || !['reserveCapability', 'capture', 'retireProgram', 'retireCleanup', 'observeEffect',
      'freezeGateway', 'publishGateway']
      .every((method) => typeof backend[method as keyof FullPlaywrightControlledSessionBackend] === 'function')) {
    throw new Error('E2E_FULL_PLAYWRIGHT_CONTROLLED_SESSION_INVALID')
  }
}
