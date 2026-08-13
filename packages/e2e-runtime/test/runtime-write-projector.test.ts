import { describe, expect, test } from 'vitest'
import {
  canonicalGrantApprovalSubjectDigest,
  canonicalizeJson,
  digestApprovalProjection,
  digestArtifactContent,
  digestCleanupPlanDefinition,
  digestRuntimeHttpBodyTemplate,
  digestRuntimeHttpResponseBody,
  digestRuntimeWriteHttpAction,
  digestText,
  type ArtifactDocument,
  type ReversibleWriteCapability,
  type SignedWriteGrant,
  type WriteApprovalSubject,
} from '@mutil-skills/e2e-contracts'
import { projectRuntimeWriteSnapshot } from '../src/runtime-write-projector.js'
import type { RuntimeRunSnapshot } from '../src/run-store.js'

const d = (value: string) => digestText('runtime-write-projector-test/v1', value)
const response = digestRuntimeHttpResponseBody(Buffer.from('{"ok":true}'))

export function runtimeWriteProjectionFixture(): RuntimeRunSnapshot {
  const bodyTemplate = {
    kind: 'segments' as const, contentType: 'application/json',
    segments: [
      { kind: 'literal' as const, value: '{"token":"' },
      { kind: 'secretRef' as const, secretRef: 'SECRET.API' },
      { kind: 'literal' as const, value: '"}' },
    ],
  }
  const action = {
    schemaVersion: '1.0.0' as const, caseId: 'CASE-1', stepId: 'STEP-1', actionId: 'ACTION-1',
    cleanupPlanId: 'CLEANUP-1',
    writeRequest: {
      requestId: 'REQUEST-WRITE', intentId: 'INTENT-WRITE', method: 'POST',
      url: 'https://test.example.com/api/orders/1', headers: [{ name: 'x-e2e-scope', value: 'orders' }],
      body: { ...bodyTemplate, templateDigest: digestRuntimeHttpBodyTemplate(bodyTemplate) },
      expectedStatus: 201, expectedResponseBodyDigest: response,
    },
    effectProbe: {
      requestId: 'REQUEST-EFFECT', intentId: 'INTENT-EFFECT', method: 'GET' as const,
      url: 'https://test.example.com/api/orders/1', headers: [], expectedStatus: 200,
      expectedResponseBodyDigest: response,
    },
  }
  const cleanup = {
    schemaVersion: '1.0.0' as const, cleanupPlanId: 'CLEANUP-1', actionId: 'ACTION-1', leaseId: 'LEASE-1',
    executorId: 'runtime-http-cleanup.v1', cleanupRequestIntentIds: ['INTENT-CLEANUP'], timeoutMs: 30_000,
    verificationProbes: [{ probeId: 'REQUEST-VERIFY', kind: 'http-response' as const, expectedDigest: response }],
    runtimeHttpCleanup: {
      request: {
        requestId: 'REQUEST-CLEANUP', intentId: 'INTENT-CLEANUP', method: 'DELETE',
        url: 'https://test.example.com/api/orders/1', headers: [], body: { kind: 'no-body' as const },
        expectedStatus: 204, expectedResponseBodyDigest: digestRuntimeHttpResponseBody(Buffer.alloc(0)),
      },
      verificationProbe: {
        requestId: 'REQUEST-VERIFY', intentId: 'INTENT-VERIFY', method: 'GET' as const,
        url: 'https://test.example.com/api/orders/1', headers: [], expectedStatus: 404,
        expectedResponseBodyDigest: response,
      },
    },
  }
  const target = d('target')
  const definitions = [action.writeRequest, action.effectProbe, cleanup.runtimeHttpCleanup.request,
    cleanup.runtimeHttpCleanup.verificationProbe]
  const requests = definitions.map((request, index) => {
    const url = new URL(request.url)
    const body = 'body' in request ? request.body : { kind: 'no-body' as const }
    return {
      intentId: request.intentId, method: request.method, canonicalOrigin: url.origin, exactPath: url.pathname,
      query: [...url.searchParams.entries()] as Array<[string, string]>, headers: request.headers,
      payload: body.kind === 'segments'
        ? { kind: 'template' as const, templateDigest: body.templateDigest }
        : { kind: 'no-body' as const },
      targetFingerprint: target, maxRequests: 1, expectedOrder: index + 1,
    }
  })
  const capability: ReversibleWriteCapability = {
    capabilityId: 'CAP-WRITE', nonce: '1'.repeat(64), transport: 'http', effect: 'reversible-write',
    operation: 'http-request', actionId: 'ACTION-1', dataLeaseId: 'LEASE-1', fencingToken: 1,
    cleanupPlanDigest: digestCleanupPlanDefinition(cleanup), requests, maxUses: 1,
  }
  const actionDigest = digestRuntimeWriteHttpAction(action)
  const testCasesContent = {
    cases: [{
      caseId: 'CASE-1', revision: 1, obligationIds: ['OBL-1'], title: '创建订单', actor: 'qa',
      necessity: 'required', preconditions: [], dataNeedIds: ['LEASE-1'],
      steps: [{ stepId: 'STEP-1', ordinal: 0, semanticAction: '创建', semanticTarget: '订单',
        oracles: [{ oracleId: 'ORACLE-1', statement: '订单已创建' }], evidenceKinds: ['gateway-audit'] }],
      mode: 'real-environment', effect: 'reversible-write', evidenceLevel: 'E2', cleanupPlanId: 'CLEANUP-1',
      timeoutMs: 30_000, retryPolicy: 'verified-not-applied-max-1', status: 'active',
    }], caseSetDigest: d('case-set'),
  }
  const executionContent = {
    environment: 'test', baseOrigin: 'https://test.example.com',
    browserMatrix: [{ browserId: 'chromium', channel: 'stable', viewportId: 'desktop' }],
    identities: [], caseQueue: [{ ordinal: 0, caseId: 'CASE-1' }], readHttpRequests: [],
    actionIntents: [{ actionId: 'ACTION-1', effect: 'reversible-write', intentDigest: actionDigest,
      runtimeHttpActionDigest: actionDigest, requestIds: [] }],
    writeHttpActions: [action], writeCleanupPlans: [cleanup],
    dataNeeds: [{ leaseId: 'LEASE-1', resourceKey: 'order:1', resourceFingerprint: target,
      mode: 'write' }], manualProcedures: [],
    evidencePolicyDigest: d('evidence'), runtimeIsolation: null, unresolvedItems: [],
  }
  const actionMapContent = {
    actionMapRevision: 1,
    pageIdentities: [{ pageId: 'PAGE-1', origin: 'https://test.example.com', assertionDigest: d('page') }],
    actions: [{
      caseId: 'CASE-1', stepId: 'STEP-1', actionId: 'ACTION-1', pageIdentityId: 'PAGE-1',
      locatorCandidates: [], playwrightAction: 'runtime-fixed-http/v1', waits: [], oracleIds: ['ORACLE-1'],
      effect: 'reversible-write', runtimeHttpActionDigest: actionDigest,
      capabilities: [{ operation: 'http-request', capabilityId: 'CAP-WRITE' }], requestIds: [],
    }], unmappedSteps: [], discoveredRisks: [],
  }
  const runBundleContent = {
    runId: 'RUN-1', allInputRefs: [{ artifactId: 'ART-test-cases', digest: d('input') }],
    schedule: [{ ordinal: 0, caseId: 'CASE-1', stepIds: ['STEP-1'], actionIds: ['ACTION-1'] }],
    attemptPlans: [{ caseId: 'CASE-1', slots: 1 }],
    signedCapabilities: [{ capabilityId: 'CAP-WRITE', actionId: 'ACTION-1', operation: 'http-request',
      effect: 'reversible-write', maxUses: 1,
      digest: digestText('approval-capability/v1', canonicalizeJson(capability)) }],
    secretRefs: ['SECRET.API'], runtimePolicyDigest: d('runtime-policy'), runtimeIsolationPolicyDigest: 'not-applicable',
  }
  const testCases = artifact('test-cases', '1.0.0', testCasesContent)
  const execution = artifact('execution-contract', '1.2.0', executionContent)
  const actionMap = artifact('browser-action-map', '2.1.0', actionMapContent)
  const runBundle = artifact('run-bundle', '2.0.0', runBundleContent)
  const subject: WriteApprovalSubject = {
    schemaVersion: '2.0.0', assetId: 'ASSET-1', prdRevision: d('prd'), executionDigest: d('execution'),
    scopeDigest: d('scope'), requirementModelDigest: d('requirements'), coveragePolicyDigest: d('coverage'),
    universeDigest: d('universe'), caseDigest: digestApprovalProjection('test-cases', testCasesContent),
    actionMapDigest: digestApprovalProjection('browser-action-map', actionMapContent), policyDigest: d('policy'),
    executionContractDigest: digestApprovalProjection('execution-contract', executionContent),
    runBundleProjectionDigest: digestApprovalProjection('run-bundle', runBundleContent), environment: 'test',
    baseOrigin: 'https://test.example.com', actor: 'qa', discoveryGrantId: 'DISCOVERY-1',
    preflightDigest: d('preflight'), actions: [{ actionId: 'ACTION-1', effect: 'reversible-write',
      dataLeaseId: 'LEASE-1', resourceKey: 'order:1', fencingToken: 1,
      cleanupPlanDigest: capability.cleanupPlanDigest, requests }],
  }
  const subjectDigest = canonicalGrantApprovalSubjectDigest(subject)
  const grant: SignedWriteGrant = {
    grantId: 'GRANT-1', issuer: 'authority', keyId: 'key', proofScope: 'local-os-user',
    approver: { subject: 'os-user:qa', roles: ['approver'] }, subject, subjectDigest,
    approvalContext: { schemaVersion: '1.0.0', subject: 'os-user:qa', runId: 'RUN-1', approvalType: 'execution',
      subjectDigest, installationDigest: d('installation'), origin: 'http://127.0.0.1:43210',
      issuedAt: '2026-07-18T00:00:00.000Z', expiresAt: '2026-07-18T01:00:00.000Z' },
    issuedAt: '2026-07-18T00:00:00.000Z', expiresAt: '2026-07-18T01:00:00.000Z',
    capabilities: [capability], revocationSequence: 0, signature: 'A'.repeat(86),
  }
  return {
    schemaVersion: '1.3.0', runId: 'RUN-1', assetId: 'ASSET-1', projectIdentityDigest: d('project'),
    runtimeInstallationDigest: d('installation'), workflow: 'approved' as never,
    artifactDigests: {}, frozenArtifacts: {
      'test-cases': testCases, 'execution-contract': execution, 'browser-action-map': actionMap, 'run-bundle': runBundle,
    }, trustedExecutionFacts: { 'signed-execution-grant': grant }, requestResponses: {},
    createdAt: '2026-07-18T00:00:00.000Z', updatedAt: '2026-07-18T00:00:00.000Z',
  }
}

function artifact(type: string, schemaVersion: string, content: unknown): ArtifactDocument {
  const document: Record<string, unknown> = {
    artifactId: `ART-${type}`, artifactType: type, schemaVersion, engineVersion: '0.1.0', assetId: 'ASSET-1',
    prdRevision: d('prd'), generationId: 'GEN-1', createdAt: '2026-07-18T00:00:00.000Z',
    contentDigest: d('placeholder'), signatures: [], dependencies: [], graph: { defines: [], references: [] }, content,
  }
  document.contentDigest = digestArtifactContent(`artifact-content/${schemaVersion}/${type}`, document)
  return document as unknown as ArtifactDocument
}

describe('Runtime write strict projector', () => {
  test('冻结合同、ActionMap、RunBundle、Signed Grant、Lease 与 cleanup 全部闭合后才投影', () => {
    const projected = projectRuntimeWriteSnapshot(runtimeWriteProjectionFixture())
    expect(projected).toMatchObject({ caseId: 'CASE-1', actionId: 'ACTION-1', secretRefs: ['SECRET.API'] })
    expect(projected.capability.requests).toHaveLength(4)
  })

  test('拒绝写 locator 与 RunBundle 未批准 secretRef', () => {
    const locator = runtimeWriteProjectionFixture()
    ;((locator.frozenArtifacts['browser-action-map']!.content as any).actions[0].locatorCandidates)
      .push({ strategy: 'role', value: 'button', confidence: 1 })
    const locatorGrant = locator.trustedExecutionFacts['signed-execution-grant'] as SignedWriteGrant
    locatorGrant.subject.actionMapDigest = digestApprovalProjection(
      'browser-action-map', locator.frozenArtifacts['browser-action-map']!.content,
    )
    rebindSubject(locatorGrant)
    expect(() => projectRuntimeWriteSnapshot(locator)).toThrow(/WRITE_ACTION_DSL_INVALID/)

    const secret = runtimeWriteProjectionFixture()
    ;(secret.frozenArtifacts['run-bundle']!.content as any).secretRefs = []
    const grant = secret.trustedExecutionFacts['signed-execution-grant'] as SignedWriteGrant
    grant.subject.runBundleProjectionDigest = digestApprovalProjection(
      'run-bundle', secret.frozenArtifacts['run-bundle']!.content,
    )
    rebindSubject(grant)
    expect(() => projectRuntimeWriteSnapshot(secret)).toThrow(/SECRET_REF_UNAPPROVED/)
  })
})

function rebindSubject(grant: SignedWriteGrant): void {
  grant.subjectDigest = canonicalGrantApprovalSubjectDigest(grant.subject)
  grant.approvalContext.subjectDigest = grant.subjectDigest
}
