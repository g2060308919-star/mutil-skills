import { describe, expect, expectTypeOf, test } from 'vitest'
import {
  ARTIFACT_TYPES, canonicalizeJson, digestBytes, digestOracleCheckpointValue, digestRuntimeIsolationPolicy, digestText,
  parseArtifactDocument,
} from '@mutil-skills/e2e-contracts'
import {
  auditArtifactSemantics, auditFinalReportFactBinding, auditVerdictFactBinding, buildCompleteGeneration, validateGeneration,
  auditRuntimeProvenanceBinding, createCompletePublicationAuditor, PatternPrivacyScanner,
  type BuildCompleteGenerationInput,
} from '../src/index.js'
import { addFixtureInjectionResult, bindFixtureExecutionOutcomeReceipt, completeGenerationFixture, rebindFixtureApprovalInputsOuterOnly,
  rebindFixtureApprovalOuterOnly, refreshFixtureApproval,
  refreshFixtureAttemptFacts, resignFixtureGatewayAudit,
  setFixtureRegressionProfile } from './complete-generation.fixture.js'

describe('完整 generation builder', () => {
  test('FinalReport 统一展示计划级审批与 Gateway 动作级二次校验，但保留执行时点', () => {
    const input = completeGenerationFixture()
    const first: any = buildCompleteGeneration(input).artifacts
      .find((artifact) => artifact.artifactType === 'final-report')!.content
    const second: any = buildCompleteGeneration(completeGenerationFixture()).artifacts
      .find((artifact) => artifact.artifactType === 'final-report')!.content

    expect(first.policyDecisions).toEqual(second.policyDecisions)
    expect(first.policyDecisions).toEqual(expect.arrayContaining([
      expect.objectContaining({ source: 'approval-freshness', stage: 'plan-approval' }),
      expect.objectContaining({ source: 'gateway-enforcement', stage: 'action-enforcement' }),
    ]))
    expect(new Set(first.policyDecisions.map((view: any) => view.decisionId)).size)
      .toBe(first.policyDecisions.length)
  })

  test('FinalReport 从 OracleCheckpointResult 确定性投影 AssertionResultV1', () => {
    const input = completeGenerationFixture()
    const expectedJson = '{"visible":true}'
    const actualJson = '{"visible":true}'
    ;(input.drafts['browser-results'].content as any).caseResults[0].stepResults[0].oracleCheckpoints = [{
      checkpointId: 'CHECKPOINT-1', oracleId: 'ORACLE-1', expectedJson, actualJson,
      expectedDigest: digestOracleCheckpointValue(expectedJson),
      actualDigest: digestOracleCheckpointValue(actualJson),
      status: 'passed', evidenceIds: ['EVIDENCE-1'],
    }]

    const report: any = buildCompleteGeneration(input).artifacts
      .find((artifact) => artifact.artifactType === 'final-report')!.content
    expect(report.caseDetails[0].steps[0].assertionResults).toEqual([{
      schemaVersion: '1.0.0', checkpointId: 'CHECKPOINT-1', oracleId: 'ORACLE-1',
      expected: { canonicalJson: expectedJson, digest: digestOracleCheckpointValue(expectedJson) },
      actual: { canonicalJson: actualJson, digest: digestOracleCheckpointValue(actualJson) },
      status: 'passed', evidenceRefs: ['EVIDENCE-1'],
    }])
  })

  test('同一 Case 的 real 与 injection 结果独立进入报告，且输入顺序不影响裁决与分区', () => {
    const forwardInput = completeGenerationFixture()
    addFixtureInjectionResult(forwardInput)
    const forward = buildCompleteGeneration(forwardInput)

    const reverseInput = completeGenerationFixture()
    addFixtureInjectionResult(reverseInput)
    ;(reverseInput.drafts['browser-results'].content as any).caseResults.reverse()
    const reversed = buildCompleteGeneration(reverseInput)

    expect(forward.terminalVerdict).toBe('accepted')
    expect(forward.verdictInput).toEqual(reversed.verdictInput)
    const report = forward.artifacts.find((item) => item.artifactType === 'final-report')!.content as any
    expect(report.caseDetails).toHaveLength(2)
    expect(report.realResults).toHaveLength(1)
    expect(report.injectionResults).toHaveLength(1)
    expect(report.realResults[0].id).not.toBe(report.injectionResults[0].id)
    expect(report.advisoryFailures).toEqual([report.injectionResults[0].id])
  })

  test('injection attempt 不得指向 real Gateway session', () => {
    const input = completeGenerationFixture()
    addFixtureInjectionResult(input)
    const sessions = (input.drafts['gateway-audit'].content as any).sessions
    const realResultId = sessions[0].resultId
    sessions[0].resultId = sessions[1].resultId
    sessions[1].resultId = realResultId

    expect(() => buildCompleteGeneration(input))
      .toThrow(/E2E_ATTEMPT_GATEWAY_SESSION_BINDING_INVALID/)
  })

  test('injection session 交换为 real reservation 时 fail closed', () => {
    const input = completeGenerationFixture()
    addFixtureInjectionResult(input)
    const sessions = (input.drafts['gateway-audit'].content as any).sessions
    sessions[1].audit.capabilityReservations = structuredClone(sessions[0].audit.capabilityReservations)

    expect(() => buildCompleteGeneration(input))
      .toThrow(/E2E_ATTEMPT_GATEWAY_RESERVATION_BINDING_INVALID/)
  })

  test('公共输入类型不允许调用方提供任何裁决事实', () => {
    type Forbidden = Extract<keyof BuildCompleteGenerationInput,
      'verdictInput' | 'terminalVerdict' | 'verdict' | 'metrics' | 'finalReport'>
    expectTypeOf<Forbidden>().toEqualTypeOf<never>()
  })

  test('caller 伪造 verifyAttemptSelection 不属于公共输入，运行时也拒绝', () => {
    const input: any = completeGenerationFixture()
    input.verdictDependencies = { verifyAttemptSelection: () => true }
    expect(() => buildCompleteGeneration(input)).toThrow(/E2E_COMPLETE_GENERATION_UNSAFE_INPUT|INPUT_KEYS_INVALID/)
  })

  test('绕过 TypeScript 注入 verdict 时，运行时边界也必须拒绝', () => {
    const forged = { ...completeGenerationFixture(), verdict: 'accepted' }
    expect(() => buildCompleteGeneration(forged as BuildCompleteGenerationInput))
      .toThrow('E2E_COMPLETE_GENERATION_INPUT_KEYS_INVALID')

    const nested = completeGenerationFixture()
    ;(nested.reportPresentation as any).metrics = { executionCoverage: 1 }
    expect(() => buildCompleteGeneration(nested))
      .toThrow('E2E_COMPLETE_GENERATION_PRESENTATION_KEYS_INVALID')
  })

  test('不再接受 caller playwrightCaseIds，Case 集只能来自专用 discovery 证明', () => {
    const forged = { ...completeGenerationFixture(), playwrightCaseIds: ['CASE-FAKE'] }
    expect(() => buildCompleteGeneration(forged as BuildCompleteGenerationInput))
      .toThrow('E2E_COMPLETE_GENERATION_INPUT_KEYS_INVALID')
  })

  test('发布前重读真实回归源码 bytes，缺证明 verifier 时 fail-closed', () => {
    const changed = completeGenerationFixture()
    changed.drafts['regression-manifest'].files![0]!.base64 = Buffer.from('// changed').toString('base64')
    expect(() => buildCompleteGeneration(changed)).toThrow('E2E_GENERATION_REGRESSION_SOURCE_BYTES_MISMATCH')

    const missing = completeGenerationFixture()
    ;(missing as any).regressionDiscoveryVerifier = undefined
    expect(() => buildCompleteGeneration(missing)).toThrow()

    const rejected = completeGenerationFixture()
    rejected.regressionDiscoveryVerifier = () => false
    expect(() => buildCompleteGeneration(rejected)).toThrow('E2E_GENERATION_REGRESSION_DISCOVERY_SIGNATURE_INVALID')
  })

  test.each([
    ['少 mapping', (content: any) => { content.caseMappings = [] }],
    ['伪 Case ID', (content: any) => { content.listResult.caseIds = ['CASE-FAKE'] }],
    ['stdout digest', (content: any) => { content.listResult.digest = digestText('attack/v1', 'stdout') }],
    ['toolchain', (content: any) => { content.toolchain.nodeVersion = '23.0.0' }],
    ['keyId', (content: any) => { content.listResult.attestation.keyId = 'generic-key' }],
    ['purpose', (content: any) => { content.listResult.attestation.purpose = 'artifact-authority-signature/v1' }],
    ['signature', (content: any) => { content.listResult.attestation.signature = 'forged' }],
    ['command', (content: any) => { content.listResult.attestation.isolation.command = ['npx', 'playwright', 'test', '--list'] }],
    ['exitCode', (content: any) => { content.listResult.attestation.isolation.exitCode = 1 }],
  ])('拒绝被篡改的 discovery %s', (_name, mutate) => {
    const input = completeGenerationFixture()
    mutate(input.drafts['regression-manifest'].content)
    expect(() => buildCompleteGeneration(input)).toThrow()
  })

  test('旧代 discovery attestation 不可复用于新 generation', () => {
    const input = completeGenerationFixture()
    input.context.generationId = 'GEN-2'
    expect(() => buildCompleteGeneration(input)).toThrow('E2E_GENERATION_REGRESSION_DISCOVERY_SIGNATURE_INVALID')
  })

  test('拒绝隐藏键、accessor、Proxy，并对 verifier 期间的原对象变化免疫', () => {
    const hidden = completeGenerationFixture()
    Object.defineProperty(hidden, 'verdict', { value: 'accepted', enumerable: false })
    expect(() => buildCompleteGeneration(hidden)).toThrow(/E2E_COMPLETE_GENERATION_UNSAFE_INPUT/)

    const accessor = completeGenerationFixture()
    Object.defineProperty(accessor.context, 'assetId', { enumerable: true, get: () => 'ASSET-1' })
    expect(() => buildCompleteGeneration(accessor)).toThrow(/E2E_COMPLETE_GENERATION_UNSAFE_INPUT/)

    const symbol = completeGenerationFixture()
    ;(symbol.context as any)[Symbol('verdict')] = 'accepted'
    expect(() => buildCompleteGeneration(symbol)).toThrow(/E2E_COMPLETE_GENERATION_UNSAFE_INPUT/)

    const nonPlain = completeGenerationFixture()
    Object.setPrototypeOf(nonPlain.reportPresentation, null)
    expect(() => buildCompleteGeneration(nonPlain)).toThrow(/E2E_COMPLETE_GENERATION_UNSAFE_INPUT/)

    const proxy = new Proxy(completeGenerationFixture(), { ownKeys: () => { throw new Error('trap executed') } })
    expect(() => buildCompleteGeneration(proxy)).toThrow(/E2E_COMPLETE_GENERATION_UNSAFE_INPUT/)

    const changing = completeGenerationFixture()
    const verifyGateway = changing.gatewayVerifier
    changing.gatewayVerifier = (proof) => {
      ;(changing.drafts['gateway-audit'].content as any).requestEvents[0].actionId = 'ACTION-TOCTOU'
      return verifyGateway(proof)
    }
    expect(() => buildCompleteGeneration(changing)).not.toThrow()
  })

  test.each([
    ['authority.signArtifactDigest', (input: BuildCompleteGenerationInput, callback: (...args: any[]) => any) => {
      input.authority.signArtifactDigest = callback
    }],
    ['authority.verifyArtifactSignature', (input: BuildCompleteGenerationInput, callback: (...args: any[]) => any) => {
      input.authority.verifyArtifactSignature = callback
    }],
    ['authority.verifyApprovalFreshnessReceipt', (input: BuildCompleteGenerationInput, callback: (...args: any[]) => any) => {
      input.authority.verifyApprovalFreshnessReceipt = callback
    }],
    ['authority.verifyDecisionReceipt', (input: BuildCompleteGenerationInput, callback: (...args: any[]) => any) => {
      input.authority.verifyDecisionReceipt = callback
    }],
    ['gatewayVerifier', (input: BuildCompleteGenerationInput, callback: (...args: any[]) => any) => {
      input.gatewayVerifier = callback
    }],
    ['sanitizerVerifier', (input: BuildCompleteGenerationInput, callback: (...args: any[]) => any) => {
      input.sanitizerVerifier = callback
    }],
    ['privacyReviewVerifier', (input: BuildCompleteGenerationInput, callback: (...args: any[]) => any) => {
      input.privacyReviewVerifier = callback
    }],
    ['regressionDiscoveryVerifier', (input: BuildCompleteGenerationInput, callback: (...args: any[]) => any) => {
      input.regressionDiscoveryVerifier = callback
    }],
    ['attemptProofVerifier', (input: BuildCompleteGenerationInput, callback: (...args: any[]) => any) => {
      input.attemptProofVerifier = callback
    }],
    ['verdictDependencies.verifyManualResult', (input: BuildCompleteGenerationInput, callback: (...args: any[]) => any) => {
      input.verdictDependencies = { verifyManualResult: callback }
    }],
  ] as const)('拒绝 Proxy-wrapped callback：%s', (_name, install) => {
    const input = completeGenerationFixture()
    const callback = new Proxy(() => true, { apply: () => { throw new Error('proxy callback trap executed') } })
    install(input, callback)
    expect(() => buildCompleteGeneration(input)).toThrow(/E2E_COMPLETE_GENERATION_UNSAFE_INPUT/)
  })

  test('accepted 基线和 Authority 决策事实都进入 VerdictInput，伪造空 findings 会被审计发现', () => {
    const baseline = buildCompleteGeneration(completeGenerationFixture())
    expect(baseline.terminalVerdict).toBe('accepted')
    expect((baseline.artifacts.find((item) => item.artifactType === 'final-report')!.content as any).diagnostics)
      .toMatchObject([{ caseId: 'CASE-1', category: 'not-required', selectedAttemptId: 'ATTEMPT-1',
        attempts: [{ attemptId: 'ATTEMPT-1', slot: 0, status: 'passed' }] }])
    const scenarios = [
      ['scope-pending', (input: BuildCompleteGenerationInput) => {
        ;(input.drafts['acceptance-scope'].content as any).scopeDecision.status = 'pending'
      }, 'pending-decision', 'pendingDecisionIds', 'SCOPE:SCOPE-1'],
      ['scope-rejected', (input: BuildCompleteGenerationInput) => {
        ;(input.drafts['acceptance-scope'].content as any).scopeDecision.status = 'rejected'
      }, 'safety-blocked', 'safetyFindings', 'SCOPE_DECISION_REJECTED'],
      ['grant-expired', (input: BuildCompleteGenerationInput) => {
        ;(input.drafts['approval-grants'].content as any).grants[0].expiresAt = input.context.createdAt
        ;(input.drafts['approval-grants'].content as any).grants[0].status = 'expired'
        ;(input.drafts['approval-grants'].content as any).grants[0].reasonCodes = ['E2E_APPROVAL_EXPIRED']
      }, 'safety-blocked', 'safetyFindings', 'EXECUTION_GRANT_EXPIRED:GRANT-1'],
      ['grant-revoked', (input: BuildCompleteGenerationInput) => {
        ;(input.drafts['approval-grants'].content as any).grants[0].status = 'revoked'
        ;(input.drafts['approval-grants'].content as any).grants[0].reasonCodes = ['E2E_APPROVAL_REVOKED']
      }, 'safety-blocked', 'safetyFindings', 'EXECUTION_GRANT_REVOKED:GRANT-1'],
      ['lineage-pending', (input: BuildCompleteGenerationInput) => {
        ;(input.drafts['prd-diff'].content as any).lineageReview.status = 'pending'
      }, 'pending-decision', 'pendingDecisionIds', 'LINEAGE:LINEAGE-1'],
      ['lineage-rejected', (input: BuildCompleteGenerationInput) => {
        ;(input.drafts['prd-diff'].content as any).lineageReview.status = 'rejected'
      }, 'safety-blocked', 'safetyFindings', 'LINEAGE_DECISION_REJECTED'],
    ] as const
    for (const [name, mutate, expected, field, expectedFact] of scenarios) {
      const candidate = completeGenerationFixture()
      mutate(candidate)
      refreshFixtureApproval(candidate)
      const built = buildCompleteGeneration(candidate)
      expect(built.terminalVerdict, name).toBe(expected)
      expect(built.verdictInput[field], name).toContain(expectedFact)
      const forged = {
        ...built.verdictInput,
        [field]: built.verdictInput[field].filter((fact) => fact !== expectedFact),
      }
      expect(auditVerdictFactBinding(built.artifacts, forged).valid, name).toBe(false)
    }
  })

  test('Builder 在 manifest root digest 前只渲染一份 Runtime provenance，独立审计拒绝 Host measurement 漂移', () => {
    const input = completeGenerationFixture()
    const built = buildCompleteGeneration(input)
    const report = built.artifacts.find((artifact) => artifact.artifactType === 'final-report')!
    const manifest = built.artifacts.find((artifact) => artifact.artifactType === 'generation-manifest')!

    expect(report.schemaVersion).toBe('3.0.0')
    expect(manifest.schemaVersion).toBe('2.0.0')
    expect((report.content as any).runtimeProvenance).toEqual(input.provenance)
    expect((manifest.content as any).runtimeProvenance).toEqual(input.provenance)
    expect(auditRuntimeProvenanceBinding(built.artifacts, input.provenance)).toEqual({ valid: true, findings: [] })

    const differentHostMeasurement = { ...input.provenance, chromiumDigest: digestText('host/v1', 'other') }
    expect(auditRuntimeProvenanceBinding(built.artifacts, differentHostMeasurement).findings.map((finding) => finding.code))
      .toContain('E2E_GENERATION_RUNTIME_PROVENANCE_HOST_MISMATCH')

    report.prdRevision = digestText('prd-revision/v1', 'forged')
    expect(auditRuntimeProvenanceBinding(built.artifacts, input.provenance).findings.map((finding) => finding.code))
      .toContain('E2E_GENERATION_RUNTIME_PROVENANCE_SOURCE_REVISION_MISMATCH')
  })

  test('Authority state protection level 精确限制报告可声称的安全边界', () => {
    const local = buildCompleteGeneration(completeGenerationFixture())
    const localReport = local.artifacts.find((artifact) => artifact.artifactType === 'final-report')!.content as any
    expect(localReport.cannotClaim).toContain(
      '本地 Authority 状态保护不能证明抵抗已控制同一 OS 用户的整体回滚，也不构成组织级不可抵赖',
    )

    const trustedInput = completeGenerationFixture()
    trustedInput.provenance.authorityStateProtectionLevel = 'trusted-monotonic'
    const trusted = buildCompleteGeneration(trustedInput)
    const trustedReport = trusted.artifacts.find((artifact) => artifact.artifactType === 'final-report')!.content as any
    expect(trustedReport.cannotClaim).not.toContain(
      '本地 Authority 状态保护不能证明抵抗已控制同一 OS 用户的整体回滚，也不构成组织级不可抵赖',
    )
  })

  test('FinalReport 独立重算 Scope subject digest，并记录 terminal DecisionReceipt digest', () => {
    const built = buildCompleteGeneration(completeGenerationFixture())
    const scope = built.artifacts.find((artifact) => artifact.artifactType === 'acceptance-scope')!.content as any
    const report = built.artifacts.find((artifact) => artifact.artifactType === 'final-report')!.content as any
    expect(report.approvals[0]).toMatchObject({
      kind: 'scope', status: 'approved',
      subjectDigest: scope.scopeDecision.receipt.decisionSubjectDigest,
      grantDigests: [scope.scopeDecision.receipt.signedDigest],
    })
    report.approvals[0].grantDigests = []
    expect(auditFinalReportFactBinding(built.artifacts).findings.map((finding) => finding.code))
      .toContain('E2E_GENERATION_REPORT_APPROVALS_MISMATCH')
  })

  test('FinalReport 固定投影 scope、lineage、execution 三类审批', () => {
    const built = buildCompleteGeneration(completeGenerationFixture())
    const diff: any = built.artifacts.find((artifact) => artifact.artifactType === 'prd-diff')!.content
    const report: any = built.artifacts.find((artifact) => artifact.artifactType === 'final-report')!.content

    expect(report.approvals.map((approval: any) => approval.kind)).toEqual(['scope', 'lineage', 'execution'])
    expect(report.approvals[1]).toEqual({
      kind: 'lineage', status: 'approved',
      approvalMode: 'webauthn',
      identityVerified: true,
      separationOfDutiesVerified: true,
      subjectDigest: diff.lineageReview.receipt.decisionSubjectDigest,
      grantDigests: [diff.lineageReview.receipt.signedDigest],
    })

    const pending = completeGenerationFixture()
    ;(pending.drafts['prd-diff'].content as any).lineageReview = { decisionId: 'LINEAGE-1', status: 'pending' }
    const pendingReport: any = buildCompleteGeneration(pending).artifacts
      .find((artifact) => artifact.artifactType === 'final-report')!.content
    expect(pendingReport.approvals[1]).toMatchObject({ kind: 'lineage', status: 'pending', grantDigests: [] })

    for (const mutate of [
      (approvals: any[]) => approvals.pop(),
      (approvals: any[]) => { approvals[1] = structuredClone(approvals[0]) },
      (approvals: any[]) => { approvals[1].kind = 'unknown' },
    ]) {
      const invalid = structuredClone(built.artifacts.find((artifact) => artifact.artifactType === 'final-report')!)
      mutate((invalid.content as any).approvals)
      expect(() => parseArtifactDocument(invalid)).toThrow()
    }
  })

  test('FinalReport 生成完整且确定的 REQ→RULE→COV→CASE→STEP→EVIDENCE 链路', () => {
    const built = buildCompleteGeneration(completeGenerationFixture())
    const report: any = built.artifacts.find((artifact) => artifact.artifactType === 'final-report')!.content

    expect(report.traceability).toEqual([
      { fromId: 'REQ-1', toId: 'RULE-1', kind: 'defines' },
      { fromId: 'RULE-1', toId: 'COV-1', kind: 'covered-by' },
      { fromId: 'COV-1', toId: 'CASE-1', kind: 'implemented-by' },
      { fromId: 'CASE-1', toId: 'STEP-1', kind: 'executes' },
      { fromId: 'STEP-1', toId: 'EVIDENCE-1', kind: 'evidenced-by' },
    ])
    expect(report.traceabilityMatrix).toEqual([{
      reqId: 'REQ-1', ruleId: 'RULE-1', obligationId: 'COV-1', caseId: 'CASE-1',
      stepId: 'STEP-1', evidenceId: 'EVIDENCE-1', evidencePath: 'evidence/case-1.json',
    }])
    expect(report.semanticTraceability).toEqual([{
      clauseId: 'CLAUSE-1', sourceId: 'SOURCE-1',
      sourceSpan: { startLine: 1, startColumn: 1, endLine: 1, endColumn: 12 },
      originalText: '首页标题必须可见', disposition: 'modeled',
      requirementId: 'REQ-1', ruleId: 'RULE-1', oracleId: 'ORACLE-1',
    }])
  })

  test('FinalReport dispositions 从 scope exclusion 事实投影，不编造状态', () => {
    const input = completeGenerationFixture()
    ;(input.drafts['acceptance-scope'].content as any).exclusions.push({
      reqId: 'REQ-EXCLUDED', rationale: '明确不在本轮验收范围', decisionId: 'SCOPE-EXCLUSION-1',
    })
    ;(input.drafts['acceptance-scope'].content as any).scopeDecision = { decisionId: 'SCOPE-1', status: 'pending' }
    refreshFixtureApproval(input)
    const report: any = buildCompleteGeneration(input).artifacts
      .find((artifact) => artifact.artifactType === 'final-report')!.content
    expect(report.dispositions).toContainEqual({
      kind: 'excluded', id: 'REQ-EXCLUDED', title: 'REQ-EXCLUDED', status: 'excluded',
      reason: '明确不在本轮验收范围', refs: ['SCOPE-EXCLUSION-1'],
    })
  })

  test.each([
    ['input-blocked', 'blocked'],
    ['environment-blocked', 'blocked'],
    ['safety-blocked', 'blocked'],
    ['automation-blocked', 'blocked'],
    ['pending-decision', 'blocked'],
    ['manual-required', 'manual'],
  ] as const)('%s 终态允许 skipped 无证据，但必须进入 disposition：%s', (status, kind) => {
    const input = completeGenerationFixture()
    const result: any = (input.drafts['browser-results'].content as any).caseResults[0]
    result.status = status
    result.stepResults[0] = {
      stepId: 'STEP-1', actionId: 'ACTION-1', status: 'skipped',
      oracleResult: 'not-evaluated', evidenceIds: [],
    }
    result.evidenceRefs = []
    ;(input.drafts['browser-evidence'].content as any).artifacts = []
    ;(input.drafts['browser-evidence'].content as any).caseCoverage = []
    ;(input.drafts['browser-evidence'].content as any).sanitizerProofs = []
    ;(input.drafts['browser-evidence'].content as any).privacyReviews = []
    refreshFixtureAttemptFacts(input)

    const built = buildCompleteGeneration(input)
    const report: any = built.artifacts.find((artifact) => artifact.artifactType === 'final-report')!.content
    expect(report.traceabilityMatrix).toEqual([])
    expect(report.traceability).not.toContainEqual({ fromId: 'STEP-1', toId: 'EVIDENCE-1', kind: 'evidenced-by' })
    expect(report.dispositions).toContainEqual({
      kind, id: 'CASE-1', title: '首页只读检查', status, reason: status, refs: ['ATTEMPT-1'],
    })
    expect(auditFinalReportFactBinding(built.artifacts).valid).toBe(true)
  })

  test('Case passed 必须由全部 scheduled Step 与 Oracle passed 推导，调用方不能自报通过', () => {
    const failedStep = completeGenerationFixture()
    const result: any = (failedStep.drafts['browser-results'].content as any).caseResults[0]
    result.stepResults[0].status = 'failed'
    result.stepResults[0].oracleResult = 'failed'
    expect(() => buildCompleteGeneration(failedStep))
      .toThrow(/E2E_GENERATION_CASE_STATUS_DERIVATION_INVALID/)

    const missingStep = completeGenerationFixture()
    ;(missingStep.drafts['browser-results'].content as any).caseResults[0].stepResults = []
    expect(() => buildCompleteGeneration(missingStep))
      .toThrow(/E2E_GENERATION_CASE_STATUS_DERIVATION_INVALID/)
  })

  test.each([
    ['delete trace edge', (report: any) => { report.traceability.pop() }],
    ['add trace edge', (report: any) => { report.traceability.push({ fromId: 'REQ-X', toId: 'RULE-X', kind: 'defines' }) }],
    ['wrong req', (report: any) => { report.traceabilityMatrix[0].reqId = 'REQ-X' }],
    ['wrong rule', (report: any) => { report.traceabilityMatrix[0].ruleId = 'RULE-X' }],
    ['wrong obligation', (report: any) => { report.traceabilityMatrix[0].obligationId = 'COV-X' }],
    ['wrong case', (report: any) => { report.traceabilityMatrix[0].caseId = 'CASE-X' }],
    ['wrong step', (report: any) => { report.traceabilityMatrix[0].stepId = 'STEP-X' }],
    ['wrong evidence', (report: any) => { report.traceabilityMatrix[0].evidenceId = 'EVIDENCE-X' }],
    ['empty matrix', (report: any) => { report.traceabilityMatrix = [] }],
    ['extra matrix row', (report: any) => { report.traceabilityMatrix.push({ ...report.traceabilityMatrix[0], evidenceId: 'EVIDENCE-X' }) }],
    ['duplicate matrix row', (report: any) => { report.traceabilityMatrix.push({ ...report.traceabilityMatrix[0] }) }],
    ['missing lineage', (report: any) => { report.approvals = report.approvals.filter((item: any) => item.kind !== 'lineage') }],
  ] as const)('FinalReport 独立重算拒绝不完整或错绑事实：%s', (_name, mutate) => {
    const artifacts = structuredClone(buildCompleteGeneration(completeGenerationFixture()).artifacts)
    const report: any = artifacts.find((artifact) => artifact.artifactType === 'final-report')!.content
    mutate(report)
    expect(auditFinalReportFactBinding(artifacts).valid).toBe(false)
  })

  test('FinalReport 独立事实审计拒绝删除或添加 disposition', () => {
    const input = completeGenerationFixture()
    ;(input.drafts['acceptance-scope'].content as any).exclusions.push({
      reqId: 'REQ-EXCLUDED', rationale: '不在本轮范围', decisionId: 'SCOPE-EXCLUSION-1',
    })
    ;(input.drafts['acceptance-scope'].content as any).scopeDecision = { decisionId: 'SCOPE-1', status: 'pending' }
    refreshFixtureApproval(input)
    const built = buildCompleteGeneration(input)
    for (const mutate of [
      (items: any[]) => items.pop(),
      (items: any[]) => items.push({ kind: 'blocked', id: 'FORGED', title: '伪造', status: 'blocked', reason: '伪造', refs: [] }),
    ]) {
      const artifacts = structuredClone(built.artifacts)
      const report: any = artifacts.find((artifact) => artifact.artifactType === 'final-report')!.content
      mutate(report.dispositions)
      expect(auditFinalReportFactBinding(artifacts).findings.map((finding) => finding.code))
        .toContain('E2E_GENERATION_REPORT_DISPOSITIONS_MISMATCH')
    }
  })

  test('执行窗口跨越 grant expiry 时 safety-blocked，不能只按 generation createdAt 判断', () => {
    const input = completeGenerationFixture()
    input.context.createdAt = '2026-07-12T00:00:00.000Z'
    ;(input.drafts['browser-results'].content as any).startedAt = '2026-07-12T00:30:00.000Z'
    ;(input.drafts['browser-results'].content as any).finishedAt = '2026-07-12T02:00:00.000Z'
    ;(input.drafts['approval-grants'].content as any).grants[0].expiresAt = '2026-07-12T01:00:00.000Z'
    ;(input.drafts['approval-grants'].content as any).grants[0].status = 'expired'
    ;(input.drafts['approval-grants'].content as any).grants[0].reasonCodes = ['E2E_APPROVAL_EXPIRED']
    refreshFixtureApproval(input)
    const built = buildCompleteGeneration(input)
    expect(built.terminalVerdict).toBe('safety-blocked')
    const forged = { ...built.verdictInput, safetyFindings: [] }
    expect(auditVerdictFactBinding(built.artifacts, forged).valid).toBe(false)
  })

  test.each([
    ['scope dependency', (input: BuildCompleteGenerationInput) => {
      ;(input.drafts['acceptance-scope'].content as any).dependencies = [{
        dependencyId: 'DEPENDENCY-1', status: 'blocked',
        digest: 'sha256:4444444444444444444444444444444444444444444444444444444444444444',
      }]
    }, 'SCOPE_DEPENDENCY_BLOCKED:DEPENDENCY-1'],
    ['execution unresolved item', (input: BuildCompleteGenerationInput) => {
      ;(input.drafts['execution-contract'].content as any).unresolvedItems = [{
        itemId: 'ITEM-1', kind: 'environment', blocking: true,
      }]
    }, 'EXECUTION_UNRESOLVED_BLOCKING:ITEM-1'],
  ] as const)('%s 阻塞事实不能 accepted，清空 environmentFindings 时审计失败', (_name, mutate, code) => {
    const input = completeGenerationFixture()
    mutate(input)
    refreshFixtureApproval(input)
    const built = buildCompleteGeneration(input)
    expect(built.terminalVerdict).toBe('environment-blocked')
    expect(built.verdictInput.environmentFindings).toContain(code)
    expect(auditVerdictFactBinding(built.artifacts, {
      ...built.verdictInput, environmentFindings: [],
    }).valid).toBe(false)
  })

  test('从 25 类事实草稿生成恰好一次的 27 类合法资产，并通过完整发布审计', () => {
    const built = buildCompleteGeneration(completeGenerationFixture())
    expect(built.artifacts.map((artifact) => artifact.artifactType).sort())
      .toEqual([...ARTIFACT_TYPES].sort())
    expect(new Set(built.artifacts.map((artifact) => artifact.artifactType)).size).toBe(27)
    built.artifacts.forEach((artifact) => expect(() => parseArtifactDocument(artifact)).not.toThrow())

    expect(validateGeneration({
      ...built.validationInput,
      artifactCandidates: built.artifacts,
      actualFiles: built.files.map((file) => ({
        relativePath: file.path, digest: file.digest, byteLength: file.byteLength,
        sanitizerOutputDigest: digestBytes('sanitizer-output/v1', file.bytes),
        bytes: file.bytes,
      })),
    })).toEqual({ valid: true, findings: [] })
    expect(built.terminalVerdict).toBe('accepted')
    expect(built.artifacts.find((artifact) => artifact.artifactType === 'final-report')?.content)
      .toMatchObject({ verdict: 'accepted', metrics: built.verdictInput ? expect.any(Object) : undefined })
  })

  test('staging 必须从当次 artifactCandidates 重建 Attempt 链，替换落盘 event 后失败', () => {
    const built = buildCompleteGeneration(completeGenerationFixture())
    const candidates: any[] = structuredClone(built.artifacts)
    const workflow = candidates.find((item) => item.artifactType === 'workflow-events')
    workflow.content.attemptCases[0].events[1].timestamp = '2026-07-11T00:00:00.000Z'
    const audit = validateGeneration({ ...built.validationInput, artifactCandidates: candidates,
      actualFiles: built.files.map((file) => ({ relativePath: file.path, digest: file.digest,
        byteLength: file.byteLength, bytes: file.bytes })) })
    expect(audit.findings.map((item) => item.code)).toEqual(expect.arrayContaining([
      'E2E_ATTEMPT_WORKFLOW_DIGEST_INVALID', 'E2E_ATTEMPT_SELECTION_BLOCKED',
    ]))
  })

  test('staging 缺失 Attempt 专用 verifier 时 fail closed', () => {
    const built = buildCompleteGeneration(completeGenerationFixture())
    const audit = validateGeneration({ ...built.validationInput, verifyAttemptEventProof: undefined,
      artifactCandidates: built.artifacts, actualFiles: built.files.map((file) => ({
        relativePath: file.path, digest: file.digest, byteLength: file.byteLength, bytes: file.bytes })) })
    expect(audit.findings.map((item) => item.code)).toContain('E2E_ATTEMPT_VERIFIER_UNAVAILABLE')
  })

  test('发布复验缺少 freshness verifier 或 Authority 状态在 staging 后变化时 fail-closed', () => {
    const input = completeGenerationFixture()
    let revoked = false
    const verify = input.authority.verifyApprovalFreshnessReceipt
    input.authority.verifyApprovalFreshnessReceipt = (receipt, binding) => revoked
      ? { authentic: false, current: false, allowed: false, status: 'invalid' }
      : verify(receipt, binding)
    const built = buildCompleteGeneration(input)
    const actualFiles = built.files.map((file) => ({ relativePath: file.path, digest: file.digest,
      byteLength: file.byteLength, sanitizerOutputDigest: digestBytes('sanitizer-output/v1', file.bytes), bytes: file.bytes }))
    const { verifyApprovalFreshnessReceipt: _missing, ...withoutFreshness } = built.validationInput
    expect(validateGeneration({ ...withoutFreshness, artifactCandidates: built.artifacts, actualFiles }).findings
      .map((finding) => finding.code)).toContain('E2E_GENERATION_APPROVAL_FRESHNESS_VERIFIER_UNAVAILABLE')
    const { verifyDecisionReceipt: _decision, ...withoutDecisionVerifier } = built.validationInput
    expect(validateGeneration({ ...withoutDecisionVerifier, artifactCandidates: built.artifacts, actualFiles }).findings
      .map((finding) => finding.code)).toContain('E2E_GENERATION_DECISION_VERIFIER_UNAVAILABLE')
    revoked = true
    expect(validateGeneration({ ...built.validationInput, artifactCandidates: built.artifacts, actualFiles }).findings
      .map((finding) => finding.code)).toContain('E2E_GENERATION_APPROVAL_FRESHNESS_INVALID')
  })

  test('首次构建拒绝旧 receipt 复用、通用 Artifact 签名替换与 verifier 缺失', () => {
    const changedScope = completeGenerationFixture()
    ;(changedScope.drafts['acceptance-scope'].content as any).dependencies = [{
      dependencyId: 'DEP-ATTACK', status: 'available', digest: digestText('attack/v1', 'changed'),
    }]
    expect(() => buildCompleteGeneration(changedScope)).toThrow(/E2E_COMPLETE_GENERATION_DECISION_INVALID/)

    const genericSignature = completeGenerationFixture()
    const decision = (genericSignature.drafts['acceptance-scope'].content as any).scopeDecision
    decision.receipt.signature = genericSignature.authority.signArtifactDigest(decision.receipt.signedDigest).signature
    expect(() => buildCompleteGeneration(genericSignature)).toThrow(/E2E_COMPLETE_GENERATION_DECISION_INVALID/)

    const noVerifier = completeGenerationFixture()
    ;(noVerifier.authority as any).verifyDecisionReceipt = undefined
    expect(() => buildCompleteGeneration(noVerifier)).toThrow()
  })

  test('complete publication auditor 在 staging 从磁盘事实再次验证 DecisionReceipt', async () => {
    const input = completeGenerationFixture()
    let decisionRevoked = false
    const verify = input.authority.verifyDecisionReceipt
    input.authority.verifyDecisionReceipt = (receipt, binding) => !decisionRevoked && verify(receipt, binding)
    const built = buildCompleteGeneration(input)
    const bytes = new Map(built.files.map((file) => [file.path, file.bytes]))
    const auditor = createCompletePublicationAuditor({
      scanner: new PatternPrivacyScanner('1.0.0'), resolveValidationInput: () => built.validationInput,
    })
    decisionRevoked = true
    await expect(auditor({
      assetId: input.context.assetId, generationId: input.context.generationId,
      terminalVerdict: built.terminalVerdict, fencingToken: input.context.fencingToken,
      stagingPath: '/staging', files: built.files.map((file) => ({
        path: file.path, digest: file.digest, byteLength: file.byteLength,
      })), readFile: async (path) => bytes.get(path)!,
    })).rejects.toMatchObject({
      code: 'E2E_PUBLICATION_AUDIT_REJECTED',
      refs: expect.arrayContaining([expect.stringContaining('E2E_GENERATION_DECISION_RECEIPT_INVALID')]),
    })
  })

  test.each([
    ['attemptPlans', (bundle: any) => { bundle.attemptPlans[0].slots = 99 }],
    ['schedule', (bundle: any) => { bundle.schedule[0].actionIds = ['ACTION-TAMPERED'] }],
    ['secretRefs', (bundle: any) => { bundle.secretRefs = ['SECRET-TAMPERED'] }],
    ['runtimePolicy', (bundle: any) => { bundle.runtimePolicyDigest = digestText('test/v1', 'tampered-policy') }],
    ['capability operation', (bundle: any) => { bundle.signedCapabilities[0].operation = 'screenshot' }],
  ] as const)('重算外层 runBundleDigest 也不能复用旧 receipt 篡改 %s', (_label, mutate) => {
    const input = completeGenerationFixture()
    mutate(input.drafts['run-bundle'].content as any)
    rebindFixtureApprovalOuterOnly(input)
    expect(() => buildCompleteGeneration(input)).toThrow()
  })

  test('纯只读执行不得夹带未审批用途的生产隔离策略', () => {
    const input = completeGenerationFixture()
    const policy = {
      schemaVersion: '1.0.0' as const, sourceDigest: digestText('test/v1', 'source'),
      allowedBackends: ['linux-bwrap' as const], gatewayEndpoint: 'http://127.0.0.1:4100',
      allowedEndpoints: ['http://127.0.0.1:4100'],
      allowedExecutableDigests: [digestText('test/v1', 'chrome')],
      limits: { cpuTimeMs: 30_000, memoryBytes: 512 * 1024 * 1024,
        diskBytes: 128 * 1024 * 1024, wallTimeMs: 60_000 },
      authorityRpcPublicKeyDigest: digestText('test/v1', 'rpc-key'),
      isolationAuthorityPublicKeyDigest: digestText('test/v1', 'isolation-key'),
    }
    ;(input.drafts['execution-contract'].content as any).runtimeIsolation = policy
    ;(input.drafts['run-bundle'].content as any).runtimeIsolationPolicyDigest =
      digestRuntimeIsolationPolicy(policy)
    refreshFixtureApproval(input)
    expect(() => buildCompleteGeneration(input))
      .toThrow(/E2E_GENERATION_RUNTIME_ISOLATION_UNEXPECTED/)
  })

  test('trusted-reversible-write 依靠可信 Compiler 证明，不强制 production isolation policy', () => {
    const input = completeWriteGenerationFixture()
    setFixtureRegressionProfile(input, 'trusted-reversible-write')
    ;(input.drafts['execution-contract'].content as any).runtimeIsolation = null
    ;(input.drafts['run-bundle'].content as any).runtimeIsolationPolicyDigest = 'not-applicable'
    refreshFixtureApproval(input)
    expect(() => buildCompleteGeneration(input)).not.toThrow()
  })

  test('full-playwright 依靠可信 Compiler 与 Discovery 证明，不被误判为未证明源码', () => {
    const input = completeWriteGenerationFixture()
    setFixtureRegressionProfile(input, 'full-playwright')
    ;(input.drafts['execution-contract'].content as any).runtimeIsolation = null
    ;(input.drafts['run-bundle'].content as any).runtimeIsolationPolicyDigest = 'not-applicable'
    refreshFixtureApproval(input)
    expect(() => buildCompleteGeneration(input)).not.toThrow()
  })

  test('production-isolated 缺少 runtime isolation policy 时仍然 fail closed', () => {
    const input = completeWriteGenerationFixture()
    setFixtureRegressionProfile(input, 'production-isolated')
    ;(input.drafts['execution-contract'].content as any).runtimeIsolation = null
    ;(input.drafts['run-bundle'].content as any).runtimeIsolationPolicyDigest = 'not-applicable'
    refreshFixtureApproval(input)
    expect(() => buildCompleteGeneration(input)).toThrow(/E2E_GENERATION_RUNTIME_ISOLATION_REQUIRED/)
  })

  test('manifest 与 Discovery attestation 的测试域或执行 Profile 不一致时拒绝发布', () => {
    const input = completeGenerationFixture()
    ;(input.drafts['regression-manifest'].content as any).executionProfile = 'trusted-reversible-write'
    expect(() => buildCompleteGeneration(input)).toThrow(/E2E_GENERATION_REGRESSION_PROFILE_MISMATCH/)
  })

  test('trusted execution 的 approvalDigest 被替换时 staging fail closed', () => {
    const input = completeGenerationFixture()
    ;(input.drafts['browser-results'].content as any).trustedCompilerExecution.approvalDigest =
      digestText('test/v1', 'other-approval')
    expect(() => buildCompleteGeneration(input)).toThrow(/E2E_GENERATION_TRUSTED_EXECUTION_MISMATCH/)
  })

  test('trusted execution 多报 Browser Results 中不存在的 Case 时 staging fail closed', () => {
    const input = completeGenerationFixture()
    ;(input.drafts['browser-results'].content as any).trustedCompilerExecution.caseResults.push({
      caseId: 'CASE-EXTRA', status: 'passed',
    })
    expect(() => buildCompleteGeneration(input)).toThrow(/E2E_GENERATION_TRUSTED_EXECUTION_MISMATCH/)
  })

  test('Chrome 或 Gateway Proxy 测量值与 Preflight 不一致时 staging fail closed', () => {
    const input = completeGenerationFixture()
    ;(input.drafts['browser-results'].content as any).trustedCompilerExecution.browserExecutableDigest =
      digestText('test/v1', 'other-browser')
    expect(() => buildCompleteGeneration(input)).toThrow(/E2E_GENERATION_TRUSTED_EXECUTION_MISMATCH/)
  })

  test.each([
    ['extra key', { authentic: true, current: true, allowed: true, status: 'valid', metadata: true }],
    ['status mismatch', { authentic: true, current: true, allowed: false, status: 'revoked' }],
    ['allowed mismatch', { authentic: true, current: true, allowed: false, status: 'valid' }],
    ['wrong boolean type', { authentic: 'true', current: true, allowed: true, status: 'valid' }],
  ] as const)('freshness verifier 返回畸形或不一致结果时 fail-closed：%s', (_label, result) => {
    const input = completeGenerationFixture()
    input.authority.verifyApprovalFreshnessReceipt = (() => result) as any
    expect(() => buildCompleteGeneration(input)).toThrow(/E2E_GENERATION_APPROVAL_FRESHNESS_INVALID/)
  })

  test.each([
    ['missing', (items: any[]) => { items.splice(0, 1) }],
    ['unknown capability', (items: any[]) => { items[0].capabilityId = 'CAPABILITY-UNKNOWN' }],
    ['wrong action', (items: any[]) => { items[0].actionId = 'ACTION-OTHER' }],
    ['not consumed', (items: any[]) => { items[0].consumed = false }],
    ['duplicate', (items: any[]) => { items.push({ ...items[0], digest: digestText('test/v1', 'duplicate') }) }],
  ] as const)('已执行 action 的签名 Gateway capability reservation 不闭合时拒绝：%s', (_label, mutate) => {
    const input = completeGenerationFixture()
    mutate((input.drafts['gateway-audit'].content as any).capabilityReservations)
    resignFixtureGatewayAudit(input)
    expect(() => buildCompleteGeneration(input)).toThrow(/E2E_GENERATION_GATEWAY_CAPABILITY_(CONSUMPTION_INVALID|UNKNOWN)/)
  })

  test.each([
    ['identity secretRef', (execution: any) => { execution.identities[0].secretRef = 'SECRET-OTHER' }],
    ['actionIntent effect', (execution: any) => { execution.actionIntents[0].effect = 'unknown' }],
    ['dataNeed', (execution: any) => { execution.dataNeeds = [{ leaseId: 'LEASE-X', resourceKey: 'R', mode: 'read' }] }],
    ['unresolvedItem', (execution: any) => { execution.unresolvedItems = [{ itemId: 'I', kind: 'approval', blocking: true }] }],
    ['browserMatrix', (execution: any) => { execution.browserMatrix[0].channel = 'other' }],
  ] as const)('重算 allInputRefs/外层摘要也不能复用旧 receipt 篡改 execution-contract：%s', (_label, mutate) => {
    const input = completeGenerationFixture()
    mutate(input.drafts['execution-contract'].content as any)
    rebindFixtureApprovalInputsOuterOnly(input)
    expect(() => buildCompleteGeneration(input)).toThrow(/E2E_GENERATION_APPROVAL_SUBJECT_MISMATCH/)
  })

  test.each([
    ['missing', (refs: any[]) => { refs.splice(0, 1) }],
    ['unknown', (refs: any[]) => { refs[0].artifactId = 'ARTIFACT-UNKNOWN' }],
    ['duplicate', (refs: any[]) => { refs.push(structuredClone(refs[0])) }],
    ['wrong digest', (refs: any[]) => { refs[0].digest = digestText('test/v1', 'wrong-ref') }],
  ] as const)('run-bundle allInputRefs 非精确 required 集合时拒绝：%s', (_label, mutate) => {
    const input = completeGenerationFixture()
    mutate((input.drafts['run-bundle'].content as any).allInputRefs)
    rebindFixtureApprovalOuterOnly(input)
    expect(() => buildCompleteGeneration(input)).toThrow()
  })

  test('单点或成组替换 evidence policy 都不能绕过批准策略闭包', () => {
    const single = completeGenerationFixture()
    ;(single.drafts['browser-evidence'].content as any).evidencePolicyDigest = digestText('test/v1', 'weak')
    expect(() => buildCompleteGeneration(single)).toThrow(/E2E_GENERATION_EVIDENCE_POLICY_BINDING_MISMATCH/)

    const grouped = completeGenerationFixture()
    const weak = digestText('test/v1', 'weak-group')
    ;(grouped.drafts['project-policy'].content as any).evidencePolicy.digest = weak
    ;(grouped.drafts['execution-contract'].content as any).evidencePolicyDigest = weak
    const evidence: any = grouped.drafts['browser-evidence'].content
    evidence.evidencePolicyDigest = weak
    evidence.artifacts.forEach((item: any) => { item.sanitizationRecord.policyDigest = weak })
    evidence.sanitizerProofs.forEach((item: any) => { item.record.policyDigest = weak })
    rebindFixtureApprovalInputsOuterOnly(grouped)
    expect(() => buildCompleteGeneration(grouped)).toThrow(/E2E_GENERATION_APPROVAL_SUBJECT_MISMATCH/)
  })

  test('成组替换为另一份真实签名 Gateway policy 仍被旧 execution approval 拒绝', () => {
    const input = completeGenerationFixture()
    const other = digestText('test/v1', 'other-runtime-policy')
    ;(input.drafts['project-policy'].content as any).runtimePolicy.digest = other
    ;(input.drafts['run-bundle'].content as any).runtimePolicyDigest = other
    ;(input.drafts['gateway-audit'].content as any).policyDigest = other
    ;(input.drafts['browser-preflight'].content as any).gatewayChecks[0].digest = other
    resignFixtureGatewayAudit(input)
    rebindFixtureApprovalInputsOuterOnly(input)
    expect(() => buildCompleteGeneration(input)).toThrow(/E2E_GENERATION_APPROVAL_SUBJECT_MISMATCH/)
  })

  test('项目 Runtime policy 与会话 Gateway policy 可不同，但 Preflight 必须绑定实际会话', () => {
    const input = completeGenerationFixture()
    const projectPolicyDigest = (input.drafts['project-policy'].content as any).runtimePolicy.digest
    const sessionGatewayPolicyDigest = digestText('test/v1', 'session-gateway-policy')
    expect(sessionGatewayPolicyDigest).not.toBe(projectPolicyDigest)

    ;(input.drafts['gateway-audit'].content as any).policyDigest = sessionGatewayPolicyDigest
    ;(input.drafts['browser-preflight'].content as any).gatewayChecks[0].digest = sessionGatewayPolicyDigest
    input.provenance.gatewayPolicyDigest = sessionGatewayPolicyDigest
    resignFixtureGatewayAudit(input)
    refreshFixtureApproval(input)

    expect(buildCompleteGeneration(input).terminalVerdict).toBe('accepted')
  })

  test.each([
    ['Case actor', (input: BuildCompleteGenerationInput) => { (input.drafts['test-cases'].content as any).cases[0].actor = 'ADMIN' }],
    ['obligation actor', (input: BuildCompleteGenerationInput) => { (input.drafts['coverage-universe'].content as any).obligations[0].actor = 'ADMIN' }],
    ['requirement actor', (input: BuildCompleteGenerationInput) => { (input.drafts['requirement-model'].content as any).requirements[0].actors = ['ADMIN'] }],
    ['execution role', (input: BuildCompleteGenerationInput) => { (input.drafts['execution-contract'].content as any).identities[0].roleIds = ['ADMIN'] }],
  ] as const)('%s 与 observedActor 不一致时拒绝发布', (_label, mutate) => {
    const input = completeGenerationFixture()
    mutate(input)
    refreshFixtureApproval(input)
    expect(() => buildCompleteGeneration(input)).toThrow(/E2E_GENERATION_ACTOR_(BINDING|TRACEABILITY)_MISMATCH/)
  })

  test('actor obligation 与 Case actor 一致时通过 traceability 审计', () => {
    const input = completeGenerationFixture()
    expect((input.drafts['coverage-universe'].content as any).obligations[0].actor).toBe('USER')
    expect(buildCompleteGeneration(input).terminalVerdict).toBe('accepted')
  })

  test('rule/critical-node 的 non-actor obligation 可用 not-applicable，由 Requirement 合法 Case actor 覆盖', () => {
    const input = completeGenerationFixture()
    ;(input.drafts['coverage-universe'].content as any).obligations[0].actor = 'not-applicable'
    refreshFixtureApproval(input)
    expect(buildCompleteGeneration(input).terminalVerdict).toBe('accepted')
  })

  test('真正错误的 obligation actor 仍拒绝', () => {
    const input = completeGenerationFixture()
    ;(input.drafts['coverage-universe'].content as any).obligations[0].actor = 'ADMIN'
    refreshFixtureApproval(input)
    expect(() => buildCompleteGeneration(input)).toThrow(/E2E_GENERATION_ACTOR_TRACEABILITY_MISMATCH/)
  })

  test('单代包含多个 scheduled actor 时 fail-closed，不能用全局 observedActor 冒充逐 Case 身份证明', () => {
    const input = completeGenerationFixture()
    const second = structuredClone((input.drafts['test-cases'].content as any).cases[0])
    second.caseId = 'CASE-2'; second.actor = 'ADMIN'; second.steps[0].stepId = 'STEP-2'
    ;(input.drafts['test-cases'].content as any).cases.push(second)
    ;(input.drafts['run-bundle'].content as any).schedule.push({
      ordinal: 1, caseId: 'CASE-2', stepIds: ['STEP-2'], actionIds: ['ACTION-1'],
    })
    refreshFixtureApproval(input)
    expect(() => buildCompleteGeneration(input)).toThrow(/E2E_GENERATION_ACTOR_BINDING_MISMATCH/)
  })

  test('缺失 CaseResult 时报告 incomplete 且不合成 realResults 摘要', () => {
    const input = completeGenerationFixture()
    ;(input.drafts['browser-results'].content as any).caseResults = []
    ;(input.drafts['browser-evidence'].content as any).artifacts = []
    ;(input.drafts['browser-evidence'].content as any).caseCoverage = []
    ;(input.drafts['browser-evidence'].content as any).sanitizerProofs = []
    ;(input.drafts['browser-evidence'].content as any).privacyReviews = []
    expect(() => buildCompleteGeneration(input)).toThrow(/E2E_ATTEMPT_CASE_COVERAGE_INVALID/)
  })

  test('已执行 reversible-write 缺少 lease/cleanupRef 时不能 accepted，闭合后可以 accepted', () => {
    const incomplete = completeGenerationFixture()
    setFixtureRegressionProfile(incomplete, 'production-isolated')
    ;(incomplete.drafts['test-cases'].content as any).cases[0].effect = 'reversible-write'
    ;(incomplete.drafts['browser-action-map'].content as any).actions[0].effect = 'reversible-write'
    ;(incomplete.drafts['execution-contract'].content as any).actionIntents[0].effect = 'reversible-write'
    ;(incomplete.drafts['browser-results'].content as any).caseResults[0].effectObservation = 'applied'
    bindFixtureWriteGatewayReservation(incomplete)
    refreshFixtureApproval(incomplete)
    expect(() => buildCompleteGeneration(incomplete))
      .toThrow(/E2E_GENERATION_EXECUTION_OUTCOME_MISSING/)

    const complete = completeGenerationFixture()
    setFixtureRegressionProfile(complete, 'production-isolated')
    ;(complete.drafts['test-cases'].content as any).cases[0].effect = 'reversible-write'
    ;(complete.drafts['test-cases'].content as any).cases[0].dataNeedIds = ['LEASE-1']
    ;(complete.drafts['browser-action-map'].content as any).actions[0].effect = 'reversible-write'
    ;(complete.drafts['execution-contract'].content as any).actionIntents[0].effect = 'reversible-write'
    ;(complete.drafts['execution-contract'].content as any).dataNeeds = [
      { leaseId: 'LEASE-1', resourceKey: 'RESOURCE-1',
        resourceFingerprint: 'sha256:1111111111111111111111111111111111111111111111111111111111111111',
        mode: 'write' },
    ]
    ;(complete.drafts['data-leases'].content as any).leases = [{
      leaseId: 'LEASE-1', resourceDigest: 'sha256:1111111111111111111111111111111111111111111111111111111111111111',
      cleanupPlanDigest: 'sha256:2222222222222222222222222222222222222222222222222222222222222222',
      status: 'released',
    }]
    ;(complete.drafts['browser-results'].content as any).caseResults[0].effectObservation = 'applied'
    ;(complete.drafts['browser-results'].content as any).caseResults[0].cleanupRef = 'LEASE-1'
    ;(complete.drafts['cleanup-results'].content as any).leaseResults = [{
      leaseId: 'LEASE-1', status: 'verified-clean',
      digest: 'sha256:3333333333333333333333333333333333333333333333333333333333333333',
    }]
    bindFixtureWriteGatewayReservation(complete)
    bindFixtureExecutionOutcomeReceipt(complete)
    refreshFixtureApproval(complete)
    expect(buildCompleteGeneration(complete).terminalVerdict).toBe('accepted')
  })

  test.each([
    ['unknown effect', (input: BuildCompleteGenerationInput) => {
      ;(input.drafts['browser-results'].content as any).caseResults[0].effectObservation = 'unknown'
    }],
    ['unknown ref', (input: BuildCompleteGenerationInput) => {
      ;(input.drafts['browser-results'].content as any).caseResults[0].cleanupRef = 'LEASE-UNKNOWN'
    }],
    ['lease not released', (input: BuildCompleteGenerationInput) => {
      ;(input.drafts['data-leases'].content as any).leases[0].status = 'active'
    }],
    ['cleanup failed', (input: BuildCompleteGenerationInput) => {
      ;(input.drafts['cleanup-results'].content as any).leaseResults[0].status = 'failed'
    }],
    ['cleanup unknown', (input: BuildCompleteGenerationInput) => {
      ;(input.drafts['cleanup-results'].content as any).leaseResults[0].status = 'unknown'
    }],
  ] as const)('write cleanup 负例：%s', (_name, mutate) => {
    const input = completeWriteGenerationFixture()
    mutate(input)
    refreshFixtureAttemptFacts(input)
    resignFixtureGatewayAudit(input)
    let accepted = false
    try { accepted = buildCompleteGeneration(input).terminalVerdict === 'accepted' } catch {}
    expect(accepted).toBe(false)
  })

  test('写结果回执缺少验签器或验签失败时拒绝发布', () => {
    const missing = completeWriteGenerationFixture()
    delete (missing as any).executionOutcomeVerifier
    expect(() => buildCompleteGeneration(missing))
      .toThrow(/E2E_GENERATION_EXECUTION_OUTCOME_VERIFIER_UNAVAILABLE/)

    const rejected = completeWriteGenerationFixture()
    rejected.executionOutcomeVerifier = () => false
    expect(() => buildCompleteGeneration(rejected))
      .toThrow(/E2E_GENERATION_EXECUTION_OUTCOME_SIGNATURE_INVALID/)
  })

  test('即使 Authority 重新批准外层记录，回执 Capability preimage 不一致仍拒绝发布', () => {
    const input = completeWriteGenerationFixture()
    ;(input.drafts['run-bundle'].content as any).signedCapabilities[0].digest = digestText(
      'approval-capability/v1', canonicalizeJson({ forged: true }),
    )
    refreshFixtureApproval(input)
    expect(() => buildCompleteGeneration(input))
      .toThrow(/E2E_GENERATION_EXECUTION_OUTCOME_CAPABILITY_MISMATCH/)
  })

  test('full-playwright 执行回执与同 operation 的 Run Bundle Capability 可以闭合', () => {
    const built = buildCompleteGeneration(completeWriteGenerationFixture())
    const artifacts = structuredClone(built.artifacts) as any[]
    const runBundle = artifacts.find((artifact) => artifact.artifactType === 'run-bundle').content
    const browserResults = artifacts.find((artifact) => artifact.artifactType === 'browser-results').content
    const caseResult = browserResults.caseResults[0]
    const receipt = caseResult.executionOutcomeReceipts[0]
    const capability = receipt.capability
    capability.operation = 'full-playwright'
    runBundle.signedCapabilities[0].operation = 'full-playwright'
    runBundle.signedCapabilities[0].digest = digestText(
      'approval-capability/v1', canonicalizeJson(capability),
    )
    caseResult.stepResults[0].evidenceIds = [`EVIDENCE-${receipt.actionId}`]
    const checkpointEvidence = ['SCREENSHOT', 'DOM', 'URL', 'TRACE']
      .map((kind) => `CHECKPOINT-1-${kind}`)
    caseResult.stepResults[0].oracleCheckpoints = [{ evidenceIds: checkpointEvidence }]
    receipt.evidenceIds = [
      ...['SCREENSHOT', 'DOM', 'URL', 'TRACE'].map((kind) => `BEFORE-${kind}`),
      ...checkpointEvidence,
      ...(['AFTER', 'CLEANUP'] as const).flatMap((stage) =>
        ['SCREENSHOT', 'DOM', 'URL', 'TRACE'].map((kind) => `${stage}-${kind}`)),
    ]
    receipt.evidenceIds.push(`GATEWAY-${receipt.gateway.executionSessionId}`)
    receipt.evidenceSetDigest = digestText(
      'execution-outcome-evidence-set/v1', canonicalizeJson([...receipt.evidenceIds].sort()),
    )
    const codes = auditArtifactSemantics(artifacts, []).findings.map((finding) => finding.code)
    expect(codes).not.toContain('E2E_GENERATION_EXECUTION_OUTCOME_CAPABILITY_MISMATCH')
    expect(codes).not.toContain('E2E_GENERATION_EXECUTION_OUTCOME_CONTEXT_MISMATCH')
  })

  test('写 Gateway execution session 错绑时，即使重新签名 Gateway audit 也拒绝发布', () => {
    const input = completeWriteGenerationFixture()
    ;(input.drafts['gateway-audit'].content as any).requestEvents[0].executionSessionId = 'SESSION-OTHER'
    resignFixtureGatewayAudit(input)
    expect(() => buildCompleteGeneration(input))
      .toThrow(/E2E_GENERATION_EXECUTION_OUTCOME_GATEWAY_MISMATCH/)
  })

  test('RunBundle signedCapabilities 为空时 passed action 不能发布', () => {
    const input = completeGenerationFixture()
    ;(input.drafts['run-bundle'].content as any).signedCapabilities = []
    expect(() => buildCompleteGeneration(input)).toThrow(/E2E_GENERATION_CAPABILITY_COVERAGE_INCOMPLETE/)
  })

  test('sanitizer outputDigest 即使与 proof 一起伪造，也必须由同一实际 bytes 的独立摘要揭穿', () => {
    const input = completeGenerationFixture()
    const evidence: any = input.drafts['browser-evidence'].content
    const forgedDigest = 'sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff'
    evidence.artifacts[0].sanitizationRecord.outputDigest = forgedDigest
    evidence.sanitizerProofs[0].record.outputDigest = forgedDigest
    expect(() => buildCompleteGeneration(input)).toThrow(/E2E_GENERATION_SANITIZER_OUTPUT_DIGEST_MISMATCH/)
  })

  test.each([
    ['scope approval', (report: any) => { report.approvals[0].status = 'rejected' }],
    ['lineage approval', (report: any) => { report.approvals[1].status = 'rejected' }],
    ['execution approval', (report: any) => { report.approvals[2].status = 'expired' }],
    ['approval assurance', (report: any) => {
      report.approvalAssurance = {
        approvalMode: 'local-confirmation',
        identityVerified: true,
        separationOfDutiesVerified: true,
      }
    }],
    ['policy decision binding', (report: any) => {
      const view = report.policyDecisions[0]
      view.binding.actionId = 'ACTION-FORGED'
      const { decisionId: _decisionId, ...body } = view
      view.decisionId = digestText('policy-decision-view/v1', canonicalizeJson(body))
    }],
    ['gateway status', (report: any) => { report.gatewayAudit.status = 'invalid' }],
    ['gateway counters', (report: any) => { report.gatewayAudit.forwarded += 1 }],
    ['noncanonical gateway counter', (report: any) => { report.gatewayAudit.forwarded = Number.NaN }],
    ['gateway digest', (report: any) => { report.gatewayAudit.digest = `sha256:${'f'.repeat(64)}` }],
    ['regression profile', (report: any) => { report.regressionDetails.executionProfile = 'production-isolated' }],
    ['real result digest', (report: any) => { report.realResults[0].digest = `sha256:${'e'.repeat(64)}` }],
    ['side effect', (report: any) => { report.sideEffects[0].effect = 'unknown' }],
    ['side effect status', (report: any) => { report.sideEffects[0].status = 'failed' }],
    ['side effect verification', (report: any) => { report.sideEffects[0].verification = 'forged' }],
    ['side effect cleanup', (report: any) => { report.sideEffects[0].cleanupStatus = 'failed' }],
  ] as const)('FinalReport 独立事实审计拒绝篡改：%s', (_name, mutate) => {
    const built = buildCompleteGeneration(completeGenerationFixture())
    const artifacts = structuredClone(built.artifacts)
    const report: any = artifacts.find((artifact) => artifact.artifactType === 'final-report')!.content
    mutate(report)
    expect(auditFinalReportFactBinding(artifacts).valid).toBe(false)
  })

  test('本地确认报告不得伪造身份验证或职责分离保证', () => {
    const built = buildCompleteGeneration(completeGenerationFixture())
    const artifacts = structuredClone(built.artifacts)
    const report: any = artifacts.find((artifact) => artifact.artifactType === 'final-report')!.content
    report.approvalAssurance = {
      approvalMode: 'local-confirmation',
      identityVerified: true,
      separationOfDutiesVerified: true,
    }
    expect(auditFinalReportFactBinding(artifacts).findings.map((finding) => finding.code))
      .toContain('E2E_GENERATION_REPORT_APPROVAL_ASSURANCE_MISMATCH')
  })

  test('Gateway 关键事实被篡改但未由 Gateway 重签时 fail closed', () => {
    const input = completeGenerationFixture()
    ;(input.drafts['gateway-audit'].content as any).requestEvents[0].actionId = 'ACTION-TAMPERED'
    expect(() => buildCompleteGeneration(input)).toThrow(/E2E_COMPLETE_GENERATION_INVALID/)
  })
})

function completeWriteGenerationFixture(): BuildCompleteGenerationInput {
  const input = completeGenerationFixture()
  setFixtureRegressionProfile(input, 'production-isolated')
  ;(input.drafts['test-cases'].content as any).cases[0].effect = 'reversible-write'
  ;(input.drafts['test-cases'].content as any).cases[0].dataNeedIds = ['LEASE-1']
  ;(input.drafts['browser-action-map'].content as any).actions[0].effect = 'reversible-write'
  ;(input.drafts['execution-contract'].content as any).actionIntents[0].effect = 'reversible-write'
  ;(input.drafts['execution-contract'].content as any).dataNeeds = [
    { leaseId: 'LEASE-1', resourceKey: 'RESOURCE-1',
      resourceFingerprint: 'sha256:1111111111111111111111111111111111111111111111111111111111111111',
      mode: 'write' },
  ]
  ;(input.drafts['data-leases'].content as any).leases = [{
    leaseId: 'LEASE-1', resourceDigest: 'sha256:1111111111111111111111111111111111111111111111111111111111111111',
    cleanupPlanDigest: 'sha256:2222222222222222222222222222222222222222222222222222222222222222',
    status: 'released',
  }]
  ;(input.drafts['browser-results'].content as any).caseResults[0].effectObservation = 'applied'
  ;(input.drafts['browser-results'].content as any).caseResults[0].cleanupRef = 'LEASE-1'
  ;(input.drafts['cleanup-results'].content as any).leaseResults = [{
    leaseId: 'LEASE-1', status: 'verified-clean',
    digest: 'sha256:3333333333333333333333333333333333333333333333333333333333333333',
  }]
  bindFixtureWriteGatewayReservation(input)
  bindFixtureExecutionOutcomeReceipt(input)
  refreshFixtureApproval(input)
  return input
}

function bindFixtureWriteGatewayReservation(input: BuildCompleteGenerationInput): void {
  const runtimeIsolationPolicy = {
    schemaVersion: '1.0.0' as const, sourceDigest: digestText('test/v1', 'write-source'),
    allowedBackends: ['linux-bwrap' as const], gatewayEndpoint: 'http://127.0.0.1:4100',
    allowedEndpoints: ['http://127.0.0.1:4100'],
    allowedExecutableDigests: [digestText('test/v1', 'write-chrome')],
    limits: { cpuTimeMs: 30_000, memoryBytes: 512 * 1024 * 1024,
      diskBytes: 128 * 1024 * 1024, wallTimeMs: 60_000 },
    authorityRpcPublicKeyDigest: digestText('test/v1', 'write-rpc-key'),
    isolationAuthorityPublicKeyDigest: digestText('test/v1', 'write-isolation-key'),
  }
  ;(input.drafts['execution-contract'].content as any).runtimeIsolation = runtimeIsolationPolicy
  input.provenance.authorityPublicKeyDigest = runtimeIsolationPolicy.authorityRpcPublicKeyDigest
  ;(input.drafts['run-bundle'].content as any).runtimeIsolationPolicyDigest =
    digestRuntimeIsolationPolicy(runtimeIsolationPolicy)
  ;(input.drafts['gateway-audit'].content as any).capabilityReservations[0].attemptContext = {
    assetId: input.context.assetId, generationId: input.context.generationId, prdRevision: input.context.prdRevision,
    runId: 'RUN-1', caseId: 'CASE-1',
  }
  resignFixtureGatewayAudit(input)
}
