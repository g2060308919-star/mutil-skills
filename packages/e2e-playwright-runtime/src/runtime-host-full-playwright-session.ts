import type { ExecutionOutcomeBinding, ExecutionOutcomeReceipt } from '@mutil-skills/e2e-contracts'
import type {
  ControlledFullPlaywrightSession,
  ControlledFullPlaywrightSessionBinding,
  FullPlaywrightBindings,
  FullPlaywrightEvidenceStage,
  FullPlaywrightEvidenceSummary,
  FullPlaywrightGatewayResult,
} from './full-playwright-runner.js'
import {
  authorizeFullPlaywrightControlledSession,
  createFullPlaywrightBrowserFacade,
} from './full-playwright-session-internal.js'
import {
  registerTrustedCompilerWriteRuntimeSession,
  type TrustedWriteRuntimeSession,
} from './production-isolation.js'

const DIGEST = /^sha256:[a-f0-9]{64}$/

export interface RuntimeHostFullPlaywrightSessionInput {
  binding: ControlledFullPlaywrightSessionBinding
  authorityRpcPublicKeyDigest: string
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

/**
 * e2e-runtime 的高层生产装配 seam。它不接受 test-only runtime，也不把原始 Browser 生命周期
 * 交给 approved source；调用方只能取得相互绑定的 runtime/session 两个 opaque capabilities。
 */
export function createRuntimeHostFullPlaywrightSession(input: RuntimeHostFullPlaywrightSessionInput): {
  runtime: TrustedWriteRuntimeSession
  session: ControlledFullPlaywrightSession
} {
  if (!DIGEST.test(input.authorityRpcPublicKeyDigest)
    || input.binding.executionProfile !== 'full-playwright'
    || input.programBindings.state !== input.cleanupBindings.state
    || input.programBindings.browser === input.cleanupBindings.browser) {
    throw new Error('E2E_FULL_PLAYWRIGHT_RUNTIME_HOST_ASSEMBLY_INVALID')
  }
  const runtime = Object.freeze({})
  registerTrustedCompilerWriteRuntimeSession(runtime, {
    mode: 'trusted-compiler', sandboxHealthy: true, gatewayConnected: true,
    authorityTransport: 'authenticated-rpc', authorityRpcPublicKeyDigest: input.authorityRpcPublicKeyDigest,
    runId: input.binding.runId, assetId: input.binding.assetId, generationId: input.binding.generationId,
    prdRevision: input.binding.prdRevision, sourceDigest: input.binding.sourceSetDigest,
  })
  const programBindings = {
    ...input.programBindings,
    browser: createFullPlaywrightBrowserFacade(input.programBindings.browser as object, {
      browserSessionId: input.binding.programBrowserSessionId,
      gatewaySessionId: input.binding.executionSessionId, lifecycle: 'program',
    }),
  }
  const cleanupBindings = {
    ...input.cleanupBindings,
    browser: createFullPlaywrightBrowserFacade(input.cleanupBindings.browser as object, {
      browserSessionId: input.binding.cleanupBrowserSessionId,
      gatewaySessionId: input.binding.executionSessionId, lifecycle: 'cleanup',
    }),
  }
  const session = authorizeFullPlaywrightControlledSession({
    binding: input.binding, programBindings, cleanupBindings, capture: input.capture,
    retireProgram: input.retireProgram, retireCleanup: input.retireCleanup,
    observeEffect: input.observeEffect, finalizeGateway: input.finalizeGateway,
    issueOutcome: input.issueOutcome, terminal: input.terminal,
  })
  return Object.freeze({ runtime, session })
}
