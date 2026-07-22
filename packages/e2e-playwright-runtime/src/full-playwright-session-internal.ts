import type {
  ControlledFullPlaywrightSession,
  ControlledFullPlaywrightSessionBinding,
  FullPlaywrightBindings,
  FullPlaywrightEvidenceStage,
  FullPlaywrightEvidenceSummary,
  FullPlaywrightGatewayResult,
} from './full-playwright-runner.js'
import type { ExecutionOutcomeBinding, ExecutionOutcomeReceipt } from '@mutil-skills/e2e-contracts'

export interface FullPlaywrightControlledSessionBackend {
  binding: ControlledFullPlaywrightSessionBinding
  programBindings: FullPlaywrightBindings
  cleanupBindings: FullPlaywrightBindings
  capture(stage: FullPlaywrightEvidenceStage): Promise<FullPlaywrightEvidenceSummary[]>
  retireProgram(): Promise<void>
  retireCleanup(): Promise<void>
  observeEffect(): 'proven-not-applied' | 'applied' | 'unknown'
  finalizeGateway(): Promise<FullPlaywrightGatewayResult>
  issueOutcome(binding: ExecutionOutcomeBinding): ExecutionOutcomeReceipt
  terminal: {
    releaseLease(input: { leaseId: string; fencingToken: number; targetFingerprint: string;
      cleanupDigest: string }): Promise<string>
    quarantineLease(input: { leaseId: string; fencingToken: number; targetFingerprint: string;
      reason: string }): Promise<string>
    completeReservation(reservationId: string, outcomeDigest: string): Promise<string>
    markReservationUnknown(reservationId: string, observation: string): Promise<string>
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
    capture: backend.capture.bind(backend),
    retireProgram: backend.retireProgram.bind(backend),
    retireCleanup: backend.retireCleanup.bind(backend),
    observeEffect: backend.observeEffect.bind(backend),
    finalizeGateway: backend.finalizeGateway.bind(backend),
    issueOutcome: backend.issueOutcome.bind(backend),
    terminal: Object.freeze({
      releaseLease: backend.terminal.releaseLease.bind(backend.terminal),
      quarantineLease: backend.terminal.quarantineLease.bind(backend.terminal),
      completeReservation: backend.terminal.completeReservation.bind(backend.terminal),
      markReservationUnknown: backend.terminal.markReservationUnknown.bind(backend.terminal),
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
    || !backend.terminal || !['releaseLease', 'quarantineLease', 'completeReservation', 'markReservationUnknown']
      .every((method) => typeof backend.terminal[method as keyof typeof backend.terminal] === 'function')
    || !['capture', 'retireProgram', 'retireCleanup', 'observeEffect', 'finalizeGateway', 'issueOutcome']
      .every((method) => typeof backend[method as keyof FullPlaywrightControlledSessionBackend] === 'function')) {
    throw new Error('E2E_FULL_PLAYWRIGHT_CONTROLLED_SESSION_INVALID')
  }
}
