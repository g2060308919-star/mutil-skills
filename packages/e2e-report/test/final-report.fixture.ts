const digest = (character: string) => `sha256:${character.repeat(64)}`
const valueMetric = { status: 'value', numerator: 1, denominator: 2, percentage: 50 }

export const finalReportFixture = {
  artifactId: 'FINAL-REPORT-1', artifactType: 'final-report', schemaVersion: '2.0.0', engineVersion: '2.0.0',
  assetId: 'PRODUCT/PRD-1', prdRevision: digest('a'), generationId: 'GEN-1',
  createdAt: '2026-07-12T00:00:00.000Z', contentDigest: digest('b'), signatures: [], dependencies: [],
  graph: { defines: [], references: [] },
  content: {
    verdictRuleVersion: '2.0.0', verdictInputDigest: digest('c'), verdict: 'safety-blocked',
    reasonCodes: ['E2E_GATEWAY_AUDIT_INVALID'], cannotClaim: ['不能宣称全部必要 Case 已可靠执行'],
    businessFailuresObserved: [], advisoryFailures: [],
    metrics: {
      requirementDesignCoverage: valueMetric, ruleCoverage: valueMetric, criticalNodeCoverage: valueMetric,
      roleCoverage: valueMetric,
      stateTransitionCoverage: { status: 'not-applicable', numerator: 0, denominator: 0, reason: '无状态转换' },
      scenarioCategoryCoverage: valueMetric, automationDispositionCoverage: valueMetric,
      executionCoverage: valueMetric, realPassRate: valueMetric, injectionPassRate: valueMetric,
      evidenceCompleteness: valueMetric, cleanupSuccess: valueMetric, blockingRate: valueMetric,
    },
    scope: [{ id: 'REQ-1', digest: digest('d') }],
    traceability: [{ fromId: 'REQ-1', toId: 'RULE-1', kind: 'defines' }],
    realResults: [{ id: 'CASE-REAL-1', digest: digest('e') }],
    injectionResults: [{ id: 'CASE-INJECT-1', digest: digest('f') }],
    manualResults: [{ id: 'MANUAL-1', digest: digest('1') }],
    risks: [{ code: 'RISK-GATEWAY', severity: 'high', ref: 'gateway-audit' }],
    regression: { manifestDigest: digest('2'), command: 'npm run e2e:regression' },
    title: '<script>alert(1)</script> 订单验收报告',
    summaries: {
      prdId: 'PRD-1', prdTitle: '订单验收', scopeDigest: digest('3'), executionContractDigest: digest('4'),
      approvalGrantDigests: [digest('5')], generationDigest: digest('6'),
    },
    approvals: [
      { kind: 'scope', status: 'approved', subjectDigest: digest('3'), grantDigests: [digest('5')] },
      { kind: 'lineage', status: 'approved', subjectDigest: digest('9'), grantDigests: [digest('a')] },
      { kind: 'execution', status: 'approved', subjectDigest: digest('4'), grantDigests: [digest('5')] },
    ],
    environment: {
      environmentId: 'STAGING', origins: ['https://example.test'],
      browser: { name: 'chromium', version: '130.0.0', channel: 'chromium' },
      roles: [{ roleId: 'AUDITOR', status: 'verified' }],
      dataLeases: [{ leaseId: 'LEASE-1', status: 'released', resourceFingerprint: digest('7') }],
    },
    dispositions: [
      { kind: 'not-applicable', id: 'COV-NA-1', title: '无状态转换', status: 'complete', reason: 'PRD 无状态变化', refs: ['REQ-1'] },
      { kind: 'blocked', id: 'CASE-BLOCKED-1', title: '网关阻断', status: 'safety-blocked', reason: '网关审计不完整', refs: ['CASE-INJECT-1'] },
    ],
    coverageUniverse: {
      universeDigest: digest('0'),
      obligations: [{ obligationId: 'COV-1', title: '审核员查看订单', necessity: 'required', disposition: 'automated', caseIds: ['CASE-REAL-1'] }],
    },
    traceabilityMatrix: [{
      reqId: 'REQ-1', ruleId: 'RULE-1', obligationId: 'COV-1', caseId: 'CASE-REAL-1',
      stepId: 'STEP-1', evidenceId: 'EVIDENCE-1', evidencePath: 'evidence/CASE-REAL-1.png',
    }],
    caseDetails: [
      {
        caseId: 'CASE-REAL-1', title: '真实列表', executionMode: 'real-environment', necessity: 'required', status: 'passed',
        preconditions: ['审核员已登录'],
        steps: [{
          stepId: 'STEP-1', action: '打开订单列表', expected: '显示订单', actual: '显示 1 条订单',
          oracle: 'heading + table row', status: 'passed', evidenceLinks: ['evidence/CASE-REAL-1.png'],
        }],
      },
      {
        caseId: 'CASE-INJECT-1', title: '500 注入', executionMode: 'browser-injection', necessity: 'required', status: 'safety-blocked',
        preconditions: ['Gateway policy 已安装'],
        steps: [{
          stepId: 'STEP-2', action: '注入 500', expected: '显示错误提示', actual: 'Gateway 计数缺失',
          oracle: 'alert', status: 'safety-blocked', evidenceLinks: [],
        }],
      },
    ],
    injectionBoundary: '只证明前端面对签名模拟响应的行为，不证明真实后端故障行为。',
    gatewayAudit: {
      status: 'invalid', digest: digest('8'), forwarded: 1, blocked: 1, injected: 1,
      findings: [{ code: 'GATEWAY-COUNT-MISMATCH', severity: 'high', ref: 'CASE-INJECT-1' }],
    },
    browserHealth: [{ code: 'CONSOLE-WARN', severity: 'low', ref: 'CASE-REAL-1' }],
    diagnostics: [{
      caseId: 'CASE-INJECT-1', category: 'safety', selectedAttemptId: 'ATTEMPT-1', rationale: 'Gateway 计数无法闭合',
      attempts: [{
        attemptId: 'ATTEMPT-1', slot: 0, status: 'safety-blocked', mode: 'gateway-injection',
        effect: 'reversible-write', eventChainDigest: digest('f'), changeDigest: null,
        sideEffectState: 'proven-not-applied', reservationSafeToVoid: true,
      }],
    }],
    sideEffects: [{
      actionId: 'ACTION-1', effect: 'reversible-write', status: 'completed', verification: '订单状态已恢复',
      cleanupStatus: 'released', digest: digest('9'),
    }],
    regressionDetails: {
      testDomain: 'prd-e2e-trusted-compiler', executionProfile: 'trusted-read-only',
      generationId: 'GEN-1', manifestDigest: digest('2'), command: 'npm run e2e:regression',
      caseIds: ['CASE-REAL-1', 'CASE-INJECT-1'],
      trustedCompiler: {
        compilerInputDigest: digest('1'), compilerVersion: '4.0.0', compilerDigest: digest('2'),
        templateVersion: '3.0.0', templateDigest: digest('3'), sourceSetDigest: digest('4'),
        discoverySignedDigest: digest('5'), nodeVersion: '24.0.0', playwrightVersion: '1.61.1',
        playwrightCliDigest: digest('6'),
        executionDigest: digest('7'),
      },
    },
    recommendations: ['修复 Gateway 签名计数后重新执行注入 Case'],
  },
}
