import {
  ApprovalGrantSubjectSchema,
  ApprovalModeSchema,
  ApprovalTypeSchema,
  LocalApprovalSummarySchema,
  PrdSemanticReviewSchema,
  canonicalizeJson,
  digestText,
  E2EError,
  type ApprovalGrantSubject,
  type ApprovalMode,
  type LocalApprovalSummary,
  type WorkflowNode,
} from '@mutil-skills/e2e-contracts'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'

const SafeIdSchema = z.string().min(1).max(256).regex(/^[A-Za-z0-9._:-]+$/)
const DigestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/)

export const PrdSourceSnapshotSchema = z.object({
  schemaVersion: z.literal('1.0.0'),
  sourceRef: z.string().min(1).max(4 * 1024),
  normalizedText: z.string().min(1).max(1024 * 1024),
  normalizedDigest: DigestSchema,
  byteLength: z.number().int().positive().max(16 * 1024 * 1024),
}).strict().superRefine((value, context) => {
  if (value.normalizedDigest !== digestText('e2e-prd-normalized-source/v1', value.normalizedText)) {
    context.addIssue({ code: 'custom', path: ['normalizedDigest'], message: 'PRD 原文摘要不匹配' })
  }
})

export const PrdSemanticConfirmationSchema = z.object({
  schemaVersion: z.literal('1.0.0'),
  confirmationId: SafeIdSchema,
  subjectDigest: DigestSchema,
  reviewDigest: DigestSchema,
  confirmedAt: z.string().datetime({ offset: true }),
  semanticReview: PrdSemanticReviewSchema,
}).strict().superRefine((value, context) => {
  if (value.reviewDigest !== value.semanticReview.reviewDigest) context.addIssue({
    code: 'custom', path: ['reviewDigest'], message: '语义确认摘要不匹配',
  })
})

export const PendingLocalApprovalConfirmationSchema = z.object({
  schemaVersion: z.literal('1.0.0'),
  confirmationId: SafeIdSchema,
  approvalType: ApprovalTypeSchema,
  subjectDigest: DigestSchema,
  projectIdentityDigest: DigestSchema,
  runtimeInstallationDigest: DigestSchema,
  workflowState: z.string().min(1).max(256),
  expiresAt: z.string().datetime({ offset: true }),
  summary: LocalApprovalSummarySchema,
  grantSubject: ApprovalGrantSubjectSchema.optional(),
  manualResult: z.object({
    manualResultId: SafeIdSchema, draftDigest: DigestSchema,
    role: z.enum(['executor', 'reviewer']),
  }).strict().optional(),
  claimRequestId: SafeIdSchema.optional(),
  claimRequestDigest: DigestSchema.optional(),
}).strict().superRefine((value, context) => {
  const grantsCapability = value.approvalType === 'discovery' || value.approvalType === 'execution'
  if (grantsCapability !== (value.grantSubject !== undefined)) context.addIssue({
    code: 'custom', path: ['grantSubject'],
    message: 'discovery/execution confirmation 必须且只能保存 grantSubject',
  })
  const manual = value.approvalType === 'manual-executor' || value.approvalType === 'manual-reviewer'
  if (manual !== (value.manualResult !== undefined)) context.addIssue({
    code: 'custom', path: ['manualResult'], message: 'manual confirmation 必须且只能保存 ManualResult 绑定',
  })
  if (value.manualResult !== undefined
    && value.approvalType !== `manual-${value.manualResult.role}`) context.addIssue({
    code: 'custom', path: ['manualResult', 'role'], message: 'ManualResult role 与 approvalType 不一致',
  })
  if ((value.claimRequestId === undefined) !== (value.claimRequestDigest === undefined)) context.addIssue({
    code: 'custom', path: ['claimRequestId'], message: 'confirmation claim 必须同时绑定 requestId/digest',
  })
})

export type PendingLocalApprovalConfirmation = z.infer<typeof PendingLocalApprovalConfirmationSchema>

export function createPendingLocalApprovalConfirmation(input: {
  approvalType: PendingLocalApprovalConfirmation['approvalType']
  subjectDigest: string
  projectIdentityDigest: string
  runtimeInstallationDigest: string
  workflowState: WorkflowNode
  summary: LocalApprovalSummary
  grantSubject?: ApprovalGrantSubject
  manualResult?: PendingLocalApprovalConfirmation['manualResult']
  now: Date
  ttlMs?: number
}): PendingLocalApprovalConfirmation {
  const ttlMs = input.ttlMs ?? 10 * 60_000
  if (!Number.isSafeInteger(ttlMs) || ttlMs < 1_000 || ttlMs > 15 * 60_000) {
    throw confirmationError('E2E_LOCAL_CONFIRMATION_TTL_INVALID')
  }
  const confirmationId = `CONFIRM-${randomUUID()}`
  const expiresAt = new Date(input.now.getTime() + ttlMs).toISOString()
  return PendingLocalApprovalConfirmationSchema.parse({
    schemaVersion: '1.0.0', confirmationId,
    approvalType: input.approvalType, subjectDigest: input.subjectDigest,
    projectIdentityDigest: input.projectIdentityDigest,
    runtimeInstallationDigest: input.runtimeInstallationDigest,
    workflowState: input.workflowState, expiresAt,
    summary: { ...input.summary, expiresAt },
    ...(input.grantSubject === undefined ? {} : { grantSubject: input.grantSubject }),
    ...(input.manualResult === undefined ? {} : { manualResult: input.manualResult }),
  })
}

export function localManualConfirmationSubjectDigest(input: {
  runId: string
  manualResultId: string
  draftDigest: string
  role: 'executor' | 'reviewer'
  workflowState: WorkflowNode
}): string {
  return digestText('local-manual-confirmation-subject/v1', canonicalizeJson(input))
}

export function assertCurrentLocalApprovalConfirmation(
  candidate: unknown,
  expected: {
    confirmationId: string
    subjectDigest: string
    projectIdentityDigest: string
    runtimeInstallationDigest: string
    workflowState: WorkflowNode
    now: Date
  },
): PendingLocalApprovalConfirmation {
  const parsed = PendingLocalApprovalConfirmationSchema.safeParse(candidate)
  if (!parsed.success) throw confirmationError('E2E_LOCAL_CONFIRMATION_NOT_FOUND')
  const value = parsed.data
  if (value.confirmationId !== expected.confirmationId
    || value.subjectDigest !== expected.subjectDigest
    || value.projectIdentityDigest !== expected.projectIdentityDigest
    || value.runtimeInstallationDigest !== expected.runtimeInstallationDigest
    || value.workflowState !== expected.workflowState) {
    throw confirmationError('E2E_LOCAL_CONFIRMATION_BINDING_MISMATCH')
  }
  if (expected.now.getTime() >= Date.parse(value.expiresAt)) {
    throw confirmationError('E2E_LOCAL_CONFIRMATION_EXPIRED')
  }
  return value
}

export function approvalModeFromTrustedFacts(facts: Record<string, unknown>): ApprovalMode {
  const parsed = ApprovalModeSchema.safeParse(facts['approval-mode'])
  return parsed.success ? parsed.data : 'webauthn'
}

export function localConfirmationReceiptDigest(input: {
  confirmation: PendingLocalApprovalConfirmation
  signedFactDigest: string
}): string {
  return digestText('local-confirmation-receipt/v1', canonicalizeJson({
    confirmationId: input.confirmation.confirmationId,
    subjectDigest: input.confirmation.subjectDigest,
    signedFactDigest: input.signedFactDigest,
  }))
}

function confirmationError(code: string): E2EError {
  return new E2EError({ code, category: 'safety', message: code, retryable: false })
}
