import {
  canonicalGrantApprovalSubjectDigest,
  canonicalizeJson,
  digestArtifactContent,
  digestText,
  type ArtifactDocument,
  type DiscoveryApprovalSubject,
  type ReadApprovalSubject,
  type SignedDiscoveryGrant,
  type SignedReadGrant,
} from '@mutil-skills/e2e-contracts'
import { describe, expect, test } from 'vitest'
import {
  TrustedActionRunner,
  TrustedReadActionProjector,
  authorizeRuntimeReadExecutor,
  executeRuntimeRead,
} from '../src/trusted-action-runner.js'

const d = (label: string) => digestText('trusted-action-test/v1', label)

describe('TrustedReadActionProjector', () => {
  test('projects URL/identity from trusted discovery fact and expected text from the frozen oracle', () => {
    const fixture = projectionFixture()
    const action = new TrustedReadActionProjector().project(fixture)

    expect(action).toMatchObject({
      caseId: 'CASE-1', stepId: 'STEP-1', actionId: 'ACTION-1',
      url: 'https://test.example.com/orders',
      expectedIdentity: {
        url: 'https://test.example.com/orders', title: '订单', heading: '订单列表', role: 'auditor',
      },
      expectedText: '页面显示待审核订单',
    })
    expect((action as any).requestCorrelations).toEqual([
      expect.objectContaining({
        requestId: 'REQUEST-PAGE', method: 'GET', url: 'https://test.example.com/orders',
        channel: 'http', actionId: 'ACTION-1', capabilityId: 'CAP-HTTP',
        ruleId: expect.stringMatching(/^sha256:/),
      }),
      expect.objectContaining({
        requestId: 'REQUEST-API', method: 'GET', url: 'https://test.example.com/api/orders',
        channel: 'http', actionId: 'ACTION-1', capabilityId: 'CAP-HTTP',
        ruleId: expect.stringMatching(/^sha256:/),
      }),
    ])
  })

  test('rejects caller-supplied or absent preflight facts instead of trusting the read grant alone', () => {
    const fixture = projectionFixture()
    delete fixture.trustedExecutionFacts['browser-preflight']
    expect(() => new TrustedReadActionProjector().project(fixture))
      .toThrow(/E2E_RUNTIME_READ_GRANT_BINDING_MISMATCH/)
  })

  test('projected Action 被嵌套修改后 WeakMap digest 失效', async () => {
    const fixture = projectionFixture()
    const action = new TrustedReadActionProjector().project(fixture)
    action.expectedIdentity.title = '伪造标题'
    await expect(new TrustedActionRunner().executeReadOnly({
      action, grant: fixture.grant, currentSubject: fixture.currentSubject,
      authority: {} as never, browser: {} as never, gateway: {} as never, attemptId: 'ATTEMPT-1',
    })).rejects.toThrow(/E2E_RUNTIME_READ_ACTION_UNTRUSTED/)
  })

  test('branded executor 仍拒绝 case/action/status/evidence 未与投影闭合的输出', async () => {
    const fixture = projectionFixture()
    const capability = authorizeRuntimeReadExecutor(async () => ({
      status: 'passed',
      result: { caseId: 'CASE-FORGED', actionId: 'ACTION-1', status: 'passed',
        expected: [], actual: [], evidence: [] },
      gatewayAudit: { received: 0, forwarded: 0, blocked: 0, byIntent: {} },
      gatewayAuditDigest: d('gateway-audit'),
    }))
    await expect(executeRuntimeRead(capability, {
      snapshot: {
        schemaVersion: '1.1.0', runId: fixture.runId, assetId: 'ASSET-1',
        projectIdentityDigest: d('project'), runtimeInstallationDigest: fixture.runtimeInstallationDigest,
        runRevision: 1,
        workflow: { current: 'compiled', sequence: 1, eventChainDigest: d('chain') },
        artifactDigests: Object.fromEntries(Object.entries(fixture.frozenArtifacts)
          .map(([key, artifact]) => [key, artifact.contentDigest])),
        frozenArtifacts: fixture.frozenArtifacts,
        trustedExecutionFacts: {
          ...fixture.trustedExecutionFacts, 'signed-execution-grant': fixture.grant,
        },
        requestResponses: {}, createdAt: '2026-07-17T00:00:00.000Z', updatedAt: '2026-07-17T00:00:00.000Z',
      },
      attemptId: 'ATTEMPT-1',
    })).rejects.toThrow(/E2E_RUNTIME_READ_EXECUTOR_OUTPUT_INVALID/)
  })
})

export function projectionFixture() {
  const installationDigest = d('installation')
  const pageRequest = {
    requestId: 'REQUEST-PAGE', method: 'GET' as const, url: 'https://test.example.com/orders',
    headers: [], bodyDigest: d('empty-body'), redirectPolicy: { mode: 'deny' as const },
  }
  const apiRequest = {
    requestId: 'REQUEST-API', method: 'GET' as const, url: 'https://test.example.com/api/orders',
    headers: [{ name: 'accept', value: 'application/json' }], bodyDigest: d('empty-body'),
    redirectPolicy: { mode: 'deny' as const },
  }
  const readRequests = [pageRequest, apiRequest]
  const requestIds = readRequests.map((request) => request.requestId)
  const testCases = artifact('test-cases', {
    cases: [{
      caseId: 'CASE-1', revision: 1, obligationIds: ['OBL-1'], title: '订单列表', actor: 'auditor',
      necessity: 'required', preconditions: [], dataNeedIds: [],
      steps: [{ stepId: 'STEP-1', ordinal: 0, semanticAction: '查看', semanticTarget: '订单列表',
        oracles: [{ oracleId: 'ORACLE-1', statement: '页面显示待审核订单' }], evidenceKinds: ['screenshot'] }],
      mode: 'real-environment', effect: 'read', evidenceLevel: 'E2', cleanupPlanId: 'not-applicable',
      timeoutMs: 10_000, retryPolicy: 'read-automation-max-2', status: 'active',
    }],
    caseSetDigest: d('case-set'),
  })
  const executionContract = artifact('execution-contract', {
    environment: 'test', baseOrigin: 'https://test.example.com',
    browserMatrix: [{ browserId: 'chromium', channel: 'chromium', viewportId: 'desktop' }],
    identities: [], caseQueue: [{ ordinal: 0, caseId: 'CASE-1' }],
    actionIntents: [{ actionId: 'ACTION-1', effect: 'read', intentDigest: d('intent'), requestIds }],
    readHttpRequests: readRequests,
    dataNeeds: [], manualProcedures: [], evidencePolicyDigest: d('evidence-policy'),
    runtimeIsolation: null, unresolvedItems: [],
  })
  const actionMap = artifact('browser-action-map', {
    actionMapRevision: 1,
    pageIdentities: [{ pageId: 'PAGE-1', origin: 'https://test.example.com', assertionDigest: d('page') }],
    actions: [{
      caseId: 'CASE-1', stepId: 'STEP-1', actionId: 'ACTION-1', pageIdentityId: 'PAGE-1',
      locatorCandidates: [{ strategy: 'role', value: 'main', confidence: 1 }],
      playwrightAction: 'read-page/v1', waits: [], oracleIds: ['ORACLE-1'], effect: 'read',
      capabilities: [
        { operation: 'local-navigation', capabilityId: 'CAP-NAV' },
        { operation: 'dom-read', capabilityId: 'CAP-DOM' },
        { operation: 'screenshot', capabilityId: 'CAP-SHOT' },
        { operation: 'http-request', capabilityId: 'CAP-HTTP' },
      ],
      requestIds,
    }],
    unmappedSteps: [], discoveredRisks: [],
  })
  const discoverySubject: DiscoveryApprovalSubject = {
    schemaVersion: '1.1.0', assetId: 'ASSET-1', prdRevision: d('prd'), scopeDigest: d('scope'),
    environment: 'test', baseOrigin: 'https://test.example.com', actor: 'auditor',
    expectedPageIdentity: {
      url: 'https://test.example.com/orders', title: '订单', heading: '订单列表', ariaSignals: [],
    },
    bootstrapIntentsDigest: d('bootstrap'),
    requests: [],
    actions: [{ actionId: 'PREFLIGHT-1', operation: 'local-navigation', maxUses: 1, requestIds: [] }],
  }
  const discoveryDigest = canonicalGrantApprovalSubjectDigest(discoverySubject)
  const discoveryGrant: SignedDiscoveryGrant = {
    grantId: 'DISCOVERY-1', issuer: 'authority', keyId: 'key', proofScope: 'local-os-user',
    approver: { subject: 'os-user:test', roles: ['approver'] }, subject: discoverySubject,
    subjectDigest: discoveryDigest,
    approvalContext: approvalContext('discovery', discoveryDigest, installationDigest),
    issuedAt: '2026-07-17T00:00:00.000Z', expiresAt: '2026-07-17T01:00:00.000Z',
    capabilities: [{
      capabilityId: 'CAP-PREFLIGHT', nonce: '0'.repeat(64), transport: 'browser-local', effect: 'read',
      actionId: 'PREFLIGHT-1', operation: 'local-navigation', maxUses: 1,
      targetUrl: discoverySubject.expectedPageIdentity.url, actor: 'auditor',
      expectedPageIdentityDigest: digestText(
        'expected-page-identity/v1', canonicalizeJson(discoverySubject.expectedPageIdentity),
      ),
      bootstrapIntentsDigest: discoverySubject.bootstrapIntentsDigest,
    }],
    revocationSequence: 0, signature: 'A'.repeat(86),
  }
  const readSubject: ReadApprovalSubject = {
    schemaVersion: '2.1.0', assetId: 'ASSET-1', prdRevision: d('prd'), scopeDigest: d('scope'),
    requirementModelDigest: d('model'), coveragePolicyDigest: d('coverage-policy'), universeDigest: d('universe'),
    caseDigest: testCases.contentDigest, actionMapDigest: actionMap.contentDigest, policyDigest: d('policy'),
    executionContractDigest: executionContract.contentDigest, runBundleProjectionDigest: d('run-bundle'),
    environment: 'test', baseOrigin: 'https://test.example.com', actor: 'auditor',
    discoveryGrantId: 'DISCOVERY-1', preflightDigest: d('preflight'),
    requests: readRequests,
    actions: [
      { actionId: 'ACTION-1', operation: 'local-navigation', maxUses: 1, requestIds: [] },
      { actionId: 'ACTION-1', operation: 'dom-read', maxUses: 1, requestIds: [] },
      { actionId: 'ACTION-1', operation: 'screenshot', maxUses: 1, requestIds: [] },
      { actionId: 'ACTION-1', operation: 'http-request', maxUses: 1, requestIds },
    ],
  }
  const readDigest = canonicalGrantApprovalSubjectDigest(readSubject)
  const readGrant: SignedReadGrant = {
    grantId: 'READ-1', issuer: 'authority', keyId: 'key', proofScope: 'local-os-user',
    approver: { subject: 'os-user:test', roles: ['approver'] }, subject: readSubject,
    subjectDigest: readDigest, approvalContext: approvalContext('execution', readDigest, installationDigest),
    issuedAt: '2026-07-17T00:00:00.000Z', expiresAt: '2026-07-17T01:00:00.000Z',
    capabilities: [
      capability('CAP-NAV', 'local-navigation'), capability('CAP-DOM', 'dom-read'),
      capability('CAP-SHOT', 'screenshot'),
      { capabilityId: 'CAP-HTTP', nonce: '4'.repeat(64), transport: 'http', effect: 'read',
        actionId: 'ACTION-1', operation: 'http-request', requestIds, maxUses: 1 },
    ],
    revocationSequence: 0, signature: 'A'.repeat(86),
  }
  return {
    runId: 'RUN-1', actionId: 'ACTION-1', runtimeInstallationDigest: installationDigest,
    frozenArtifacts: {
      'test-cases': testCases, 'execution-contract': executionContract, 'browser-action-map': actionMap,
    },
    trustedExecutionFacts: {
      'signed-discovery-grant': discoveryGrant,
      'browser-preflight': {
        runId: 'RUN-1', discoveryGrantId: 'DISCOVERY-1', reservationId: 'RESERVATION-1',
        preflightDigest: d('preflight'), status: 'ready',
        observedIdentityDigest: d('observed-identity'),
        browserMeasurementDigest: d('browser-measurement'), browserClosureDigest: d('browser-closure'),
        browserExecutableDigest: d('browser-executable'),
        gatewaySessionMeasurementDigest: d('gateway-session'), gatewayPolicyDigest: d('gateway-policy'),
        gatewayAuditDigest: d('gateway-audit'),
        canaryProofDigest: d('canary-proof'), authorityOutcomeDigest: d('authority-outcome'),
        authorityReceiptDigest: d('authority-receipt'),
      },
    } as Record<string, unknown>,
    grant: readGrant, currentSubject: readSubject,
  }
}

function artifact(type: 'test-cases' | 'execution-contract' | 'browser-action-map', content: unknown): ArtifactDocument {
  const schemaVersion = type === 'browser-action-map' ? '2.1.0'
    : type === 'execution-contract' ? '1.1.0' : '1.0.0'
  const document: Record<string, unknown> = {
    artifactId: `ARTIFACT-${type}`, artifactType: type, schemaVersion, engineVersion: '0.1.0',
    assetId: 'ASSET-1', prdRevision: d('prd'), generationId: 'RUN-1',
    createdAt: '2026-07-17T00:00:00.000Z', contentDigest: d('placeholder'),
    signatures: [], dependencies: [], graph: { defines: [], references: [] }, content,
  }
  document.contentDigest = digestArtifactContent(`artifact-content/${schemaVersion}/${type}`, document)
  return document as unknown as ArtifactDocument
}

function approvalContext(type: 'discovery' | 'execution', subjectDigest: string, installationDigest: string) {
  return {
    schemaVersion: '1.0.0' as const, subject: 'os-user:test', runId: 'RUN-1', approvalType: type,
    subjectDigest, installationDigest, origin: 'http://127.0.0.1:43210',
    issuedAt: '2026-07-17T00:00:00.000Z', expiresAt: '2026-07-17T01:00:00.000Z',
  }
}

function capability(capabilityId: string, operation: 'local-navigation' | 'dom-read' | 'screenshot') {
  return {
    capabilityId, nonce: (operation === 'local-navigation' ? '1' : operation === 'dom-read' ? '2' : '3').repeat(64),
    transport: 'browser-local' as const, effect: 'read' as const,
    actionId: 'ACTION-1', operation, maxUses: 1,
  }
}
