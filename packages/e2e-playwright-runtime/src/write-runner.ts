import {
  canonicalizeJson,
  digestBytes,
  digestText,
  type GatewayAuditSummary,
  type SignedWriteGrant,
  type WriteApprovalSubject,
} from '@mutil-skills/e2e-contracts'
import {
  getTrustedExecutionClientBinding,
  isTrustedLeaseClient,
  isTrustedWriteApprovalClient,
  type TrustedLeaseClient,
  type TrustedWriteApprovalClient,
} from '@mutil-skills/e2e-authority'
import type { BrowserPageAdapter, ObservedPageIdentity, RuntimeEvidenceSummary } from './read-only-runner.js'
import {
  getWriteRuntimeSessionBinding,
  type TrustedWriteRuntimeSession,
} from './production-isolation.js'

export interface WriteBrowserPageAdapter extends BrowserPageAdapter {
  clickButton(name: string): Promise<void>
  waitForText(text: string): Promise<boolean>
}

export interface ReversibleWriteCaseResult {
  caseId: string
  actionId: string
  status: 'passed' | 'failed' | 'environment-blocked' | 'safety-blocked'
  effectObservation: 'proven-not-applied' | 'applied' | 'unknown'
  reasonCode?: string
  expected: string[]
  actual: string[]
  observedIdentity?: ObservedPageIdentity
  evidence: RuntimeEvidenceSummary[]
}

export interface RunReversibleWriteCaseInput {
  caseId: string
  actionId: string
  url: string
  buttonName: string
  beforeText: string
  afterText: string
  expectedIdentity: { title: string; heading: string }
  authorization: {
    grant: SignedWriteGrant
    currentSubject: WriteApprovalSubject
    authority: TrustedWriteApprovalClient
  }
  lease: {
    leaseId: string
    fencingToken: number
    targetFingerprint: string
    authority: TrustedLeaseClient
  }
  runtime: TrustedWriteRuntimeSession
  gatewayAudit: GatewayAuditSummary | (() => GatewayAuditSummary)
  page: WriteBrowserPageAdapter
}

export async function runReversibleWriteCase(input: RunReversibleWriteCaseInput): Promise<ReversibleWriteCaseResult> {
  const safetyCode = await safetyPrecondition(input)
  if (safetyCode) return baseResult(input, 'safety-blocked', safetyCode, 'proven-not-applied')

  let writeAttempted = false
  try {
    await input.page.goto(input.url)
    const observedIdentity = await input.page.identity()
    if (observedIdentity.title !== input.expectedIdentity.title || !observedIdentity.headings.includes(input.expectedIdentity.heading)) {
      return { ...baseResult(input, 'environment-blocked', 'E2E_RUNTIME_PAGE_MISMATCH', 'proven-not-applied'), observedIdentity }
    }
    if (!await input.page.containsText(input.beforeText)) {
      return { ...baseResult(input, 'failed', 'E2E_RUNTIME_PRECONDITION_MISMATCH', 'proven-not-applied'), observedIdentity }
    }

    writeAttempted = true
    await input.page.clickButton(input.buttonName)
    const changed = await input.page.waitForText(input.afterText)
    const gatewayAudit = typeof input.gatewayAudit === 'function' ? input.gatewayAudit() : input.gatewayAudit
    if (gatewayAudit.forwarded <= 0) {
      return { ...baseResult(input, 'safety-blocked', 'E2E_RUNTIME_WRITE_GATEWAY_AUDIT_INCOMPLETE', 'unknown'), observedIdentity }
    }
    const screenshot = await input.page.screenshot()
    const dom = await input.page.domSnapshot()
    const gatewayAuditText = canonicalizeJson(gatewayAudit)
    return {
      caseId: input.caseId,
      actionId: input.actionId,
      status: changed ? 'passed' : 'failed',
      effectObservation: changed ? 'applied' : 'unknown',
      expected: [`状态从“${input.beforeText}”变为“${input.afterText}”`],
      actual: [changed ? `页面显示“${input.afterText}”` : `页面未显示“${input.afterText}”`],
      observedIdentity,
      evidence: [
        { kind: 'screenshot', byteLength: screenshot.byteLength,
          digest: digestBytes('runtime-evidence/screenshot/v1', screenshot) },
        { kind: 'dom', byteLength: Buffer.byteLength(dom, 'utf8'),
          digest: digestText('runtime-evidence/dom/v1', dom) },
        { kind: 'gateway-audit', byteLength: Buffer.byteLength(gatewayAuditText, 'utf8'),
          digest: digestText('runtime-evidence/gateway-audit/v1', gatewayAuditText) },
      ],
    }
  } catch {
    return baseResult(input, 'environment-blocked', 'E2E_RUNTIME_PAGE_UNAVAILABLE',
      writeAttempted ? 'unknown' : 'proven-not-applied')
  }
}

async function safetyPrecondition(input: RunReversibleWriteCaseInput): Promise<string | undefined> {
  const runtime = getWriteRuntimeSessionBinding(input.runtime)
  if (!runtime) return 'E2E_RUNTIME_TRUSTED_SESSION_REQUIRED'
  if (!runtime.sandboxHealthy) return 'E2E_RUNTIME_SANDBOX_REQUIRED'
  if (!runtime.gatewayConnected) return 'E2E_RUNTIME_GATEWAY_REQUIRED'
  if (!isTrustedWriteApprovalClient(input.authorization.authority)
    || !isTrustedLeaseClient(input.lease.authority)) return 'E2E_RUNTIME_TRUSTED_AUTHORITY_CLIENT_REQUIRED'
  const writeBinding = getTrustedExecutionClientBinding(input.authorization.authority)
  const leaseBinding = getTrustedExecutionClientBinding(input.lease.authority)
  const approvalBinding = writeBinding?.approvalBinding
  const grantContext = input.authorization.grant.approvalContext
  if (!approvalBinding
    || approvalBinding.runId !== grantContext.runId
    || approvalBinding.installationDigest !== grantContext.installationDigest
    || approvalBinding.approvalType !== grantContext.approvalType
    || approvalBinding.subjectDigest !== grantContext.subjectDigest
    || ('runId' in runtime && runtime.runId !== approvalBinding.runId)) {
    return 'E2E_RUNTIME_APPROVAL_CONTEXT_MISMATCH'
  }
  if (runtime.authorityTransport === 'in-process-test') {
    if (writeBinding?.transport !== 'in-process-test' || leaseBinding?.transport !== 'in-process-test') {
      return 'E2E_RUNTIME_AUTHORITY_TRANSPORT_MISMATCH'
    }
  } else {
    const expectedDigest = runtime.authorityRpcPublicKeyDigest
    if (!expectedDigest || writeBinding?.transport !== 'authenticated-rpc'
      || leaseBinding?.transport !== 'authenticated-rpc'
      || writeBinding.authorityPublicKeyDigest !== expectedDigest
      || leaseBinding.authorityPublicKeyDigest !== expectedDigest) {
      return 'E2E_RUNTIME_AUTHORITY_TRANSPORT_MISMATCH'
    }
  }
  const grant = immutableJsonSnapshot<SignedWriteGrant>(input.authorization.grant)
  const currentSubject = immutableJsonSnapshot<WriteApprovalSubject>(input.authorization.currentSubject)
  const capabilities = grant.capabilities.filter((capability) =>
    capability.actionId === input.actionId && capability.effect === 'reversible-write')
  if (capabilities.length !== 1) {
    return 'E2E_RUNTIME_WRITE_CAPABILITY_REQUIRED'
  }
  const capability = capabilities[0]!
  if (capability.dataLeaseId !== input.lease.leaseId
    || capability.fencingToken !== input.lease.fencingToken
    || capability.requests.length === 0
    || capability.requests.some((request) => request.targetFingerprint !== input.lease.targetFingerprint)) {
    return 'E2E_RUNTIME_WRITE_LEASE_BINDING_MISMATCH'
  }
  try {
    const decision = await input.authorization.authority.verifyForSubject(grant, currentSubject)
    if (!decision.allowed) return decision.code
  } catch {
    return 'E2E_RUNTIME_WRITE_AUTHORIZATION_DENIED'
  }
  try {
    if (!await input.lease.authority.verifyTarget(
      input.lease.leaseId, input.lease.fencingToken, input.lease.targetFingerprint,
    )) return 'E2E_RUNTIME_ACTIVE_LEASE_REQUIRED'
  } catch {
    return 'E2E_RUNTIME_LEASE_VERIFICATION_FAILED'
  }
  return undefined
}

function immutableJsonSnapshot<T>(value: T): T {
  return JSON.parse(canonicalizeJson(value)) as T
}

function baseResult(
  input: RunReversibleWriteCaseInput,
  status: ReversibleWriteCaseResult['status'],
  reasonCode: string,
  effectObservation: ReversibleWriteCaseResult['effectObservation'],
): ReversibleWriteCaseResult {
  return {
    caseId: input.caseId,
    actionId: input.actionId,
    status,
    effectObservation,
    reasonCode,
    expected: [`状态从“${input.beforeText}”变为“${input.afterText}”`],
    actual: [],
    evidence: [],
  }
}
