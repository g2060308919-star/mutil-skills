export interface CanonicalHttpRequest {
  method: string
  origin: string
  path: string
  query: Array<[string, string]>
}

export interface ReadIntent {
  intentId: string
  actionId: string
  stage: 'bootstrap' | 'case'
  methods: Array<'GET' | 'HEAD'>
  origin: string
  exactPath: string
  query: Array<[string, string]>
  maxRequests: number
}

export type GatewayDecision =
  | { decision: 'forward'; intentId: string; request: CanonicalHttpRequest }
  | { decision: 'block'; code: string; reason: string; request?: CanonicalHttpRequest }

export interface GatewayAuditSummary {
  received: number
  forwarded: number
  blocked: number
  byIntent: Record<string, number>
}

export interface InjectionGatewayAuditSummary {
  source: 'egress-gateway' | 'browser-route'
  received: number
  matched: number
  forwarded: number
  blocked: number
  bootstrapForwarded: number
  injectionTargetForwarded: number
  byIntent: Record<string, number>
}

export type InjectionGatewayDecision =
  | GatewayDecision
  | {
      decision: 'inject'
      source: 'egress-gateway'
      capabilityId: string
      intentId: string
      request: CanonicalHttpRequest
      response: CanonicalInjectionResponse
    }
import type { CanonicalInjectionResponse } from './approval.js'
