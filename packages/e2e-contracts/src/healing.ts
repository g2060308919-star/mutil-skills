export interface LocatorCandidate {
  strategy: 'role' | 'label' | 'test-id' | 'css'
  value: string
}

export interface ExplicitWaitCondition {
  kind: 'visible' | 'attached' | 'response' | 'url' | 'text'
  timeoutMs: number
}

export type HealingMutation =
  | { kind: 'locator-candidate'; before: LocatorCandidate[]; after: LocatorCandidate[] }
  | { kind: 'locator-scope'; before: LocatorCandidate; after: LocatorCandidate }
  | { kind: 'wait-condition'; before: ExplicitWaitCondition; after: ExplicitWaitCondition }
  | { kind: 'equivalent-action'; before: string; after: string }
  | { kind: 'page-identity-nonrequirement-signal'; before: { name: string; value: string }; after: { name: string; value: string } }
  | { kind: 'evidence-capture-point'; before: string[]; after: string[] }
  | { kind: 'injection-technical-matcher'; before: string; after: string }

export interface HealingProposal {
  proposalId: string
  actionId: string
  baseRevision: number
  caseTimeoutMs: number
  semanticDigestBefore: string
  semanticDigestAfter: string
  approvalSubjectDigestBefore: string
  approvalSubjectDigestAfter: string
  mutations: HealingMutation[]
}

export interface HealingReviewContext {
  currentSemanticDigest: string
  currentApprovalSubjectDigest: string
  protectedPageIdentitySignals: string[]
}

export type HealingReview =
  | {
      accepted: true
      reasonCodes: []
      nextRevision: number
      actionMapDigest: string
      requiresReapproval: boolean
    }
  | { accepted: false; reasonCodes: string[] }
