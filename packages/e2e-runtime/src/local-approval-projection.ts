import {
  LocalApprovalSummarySchema,
  type ApprovalEffect,
  type ApprovalGrantSubject,
  type LocalApprovalSummary,
} from '@mutil-skills/e2e-contracts'
import type { RuntimeRunSnapshot } from './run-store.js'
import { localApprovalDisposition, projectRiskTier, type LocalApprovalDisposition } from './local-approval-policy.js'

export function projectLocalApproval(input: {
  snapshot: Pick<RuntimeRunSnapshot, 'runId' | 'frozenArtifacts'>
  approvalType: LocalApprovalSummary['approvalType']
  subjectDigest: string
  grantSubject?: ApprovalGrantSubject
  expiresAt: string
}): { summary: LocalApprovalSummary; disposition: LocalApprovalDisposition } {
  const subject = input.grantSubject as unknown
  const records = collectRecords(subject)
  const environmentId = stringField(subject, 'environment')
    ?? firstPolicyEnvironment(input.snapshot)?.environmentId ?? 'UNKNOWN'
  const policyEnvironment = policyEnvironments(input.snapshot)
    .find((environment) => environment.environmentId.toLowerCase() === environmentId.toLowerCase())
  const riskTier = projectRiskTier(policyEnvironment?.riskTier)
  const effects = projectEffects(input.approvalType, records)
  const hasInjection = input.approvalType === 'execution'
    && records.some((record) => 'response' in record || record.effect === 'injection')
  const hasPrivacyUnlock = input.approvalType === 'privacy'
  const hasManualFinalization = input.approvalType === 'manual-executor'
    || input.approvalType === 'manual-reviewer'
  const origins = unique(records.flatMap((record) => [
    string(record.baseOrigin), string(record.canonicalOrigin), string(record.origin),
  ]).filter(isCanonicalOrigin)).sort()
  const methods = unique(records.map((record) => string(record.method)?.toUpperCase())
    .filter(isHttpMethod)).sort()
  const maxUses = Math.max(0, ...records.map((record) => safePositiveInteger(record.maxUses)))
  const summary = LocalApprovalSummarySchema.parse({
    runId: input.snapshot.runId,
    approvalType: input.approvalType,
    environmentId,
    riskTier,
    origins,
    methods,
    actionCount: arrayField(subject, 'actions')?.length ?? 0,
    effects: unique(effects).sort(),
    maxUses,
    secretRefs: unique(records.map((record) => string(record.secretRef)).filter(isSafeId)).sort(),
    dataLeaseRefs: unique(records.map((record) => string(record.dataLeaseId)).filter(isSafeId)).sort(),
    cleanupRefs: unique(records.flatMap((record) => [
      string(record.cleanupPlanId), string(record.cleanupPlanDigest),
    ]).filter(isSafeId)).sort(),
    injectionClassifications: unique(records.map((record) => {
      const response = plain(record.response) ? record.response : undefined
      return response === undefined ? undefined : string(response.kind)
    }).filter(isSafeId)).sort(),
    subjectDigest: input.subjectDigest,
    expiresAt: input.expiresAt,
  })
  return {
    summary,
    disposition: localApprovalDisposition({
      approvalType: input.approvalType,
      riskTier,
      effects,
      hasInjection,
      hasPrivacyUnlock,
      hasManualFinalization,
    }),
  }
}

function projectEffects(
  approvalType: LocalApprovalSummary['approvalType'],
  records: Record<string, unknown>[],
): Array<ApprovalEffect | 'unknown'> {
  if (approvalType === 'privacy') return ['privacy-unlock']
  if (approvalType === 'manual-executor' || approvalType === 'manual-reviewer') return ['manual']
  if (approvalType === 'scope' || approvalType === 'lineage' || approvalType === 'discovery') return ['read']
  const actions = records.filter((record) => typeof record.actionId === 'string')
  if (actions.length === 0) return ['unknown']
  return actions.map((action) => {
    if (action.effect === 'read' || action.effect === 'reversible-write'
      || action.effect === 'irreversible-write') return action.effect
    if ('response' in action) return 'injection'
    if (typeof action.operation === 'string') return 'read'
    if ((typeof action.origin === 'string' && typeof action.path === 'string'
      && Number.isSafeInteger(action.maxInboundMessages) && Number.isSafeInteger(action.maxBytes))
      || (typeof action.origin === 'string' && typeof action.exactPath === 'string'
        && Array.isArray(action.query) && Number.isSafeInteger(action.maxReconnects))) return 'read'
    return 'unknown'
  })
}

function policyEnvironments(snapshot: Pick<RuntimeRunSnapshot, 'frozenArtifacts'>): Array<{
  environmentId: string
  riskTier?: unknown
}> {
  const artifact = snapshot.frozenArtifacts['project-policy'] as unknown
  const content = plain(artifact) && plain(artifact.content) ? artifact.content : undefined
  const environments = content === undefined ? undefined : content.environments
  if (!Array.isArray(environments)) return []
  return environments.filter(plain).flatMap((environment) => typeof environment.environmentId === 'string'
    ? [{ environmentId: environment.environmentId, riskTier: environment.riskTier }] : [])
}

function firstPolicyEnvironment(snapshot: Pick<RuntimeRunSnapshot, 'frozenArtifacts'>) {
  return policyEnvironments(snapshot)[0]
}

function collectRecords(value: unknown): Record<string, unknown>[] {
  const output: Record<string, unknown>[] = []
  const visit = (candidate: unknown, depth: number) => {
    if (depth > 16 || output.length >= 100_000) return
    if (Array.isArray(candidate)) {
      for (const item of candidate) visit(item, depth + 1)
      return
    }
    if (!plain(candidate)) return
    output.push(candidate)
    for (const nested of Object.values(candidate)) visit(nested, depth + 1)
  }
  visit(value, 0)
  return output
}

function stringField(value: unknown, key: string): string | undefined {
  return plain(value) ? string(value[key]) : undefined
}

function arrayField(value: unknown, key: string): unknown[] | undefined {
  return plain(value) && Array.isArray(value[key]) ? value[key] : undefined
}

function safePositiveInteger(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : 0
}

function string(value: unknown): string | undefined { return typeof value === 'string' ? value : undefined }
function plain(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
function unique<T>(values: T[]): T[] { return [...new Set(values)] }
function isSafeId(value: string | undefined): value is string {
  return value !== undefined && /^[A-Za-z0-9._:-]{1,256}$/.test(value)
}
function isCanonicalOrigin(value: string | undefined): value is string {
  if (value === undefined) return false
  try { return new URL(value).origin === value } catch { return false }
}
function isHttpMethod(value: string | undefined): value is LocalApprovalSummary['methods'][number] {
  return value !== undefined && ['GET', 'HEAD', 'OPTIONS', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(value)
}
