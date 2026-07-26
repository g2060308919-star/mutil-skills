import { describe, expect, test } from 'vitest'
import { canonicalizeJson, deriveExecutionResultId, digestBytes, digestText,
  type VerdictInput } from '@mutil-skills/e2e-contracts'
import {
  auditArtifactGraph, auditArtifactSemantics, auditFinalVerdict, auditGenerationFiles,
  auditVerdictFactBinding, computeVerdict,
  collectGenerationFiles, computeFinalizationSnapshotDigest, computeGenerationRootDigest, validateGeneration,
  migrateCleanupResultsV1,
  type AuditableArtifact, type SemanticArtifact,
} from '../src/index.js'
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const digest = (character: string) => `sha256:${character.repeat(64)}`
const semanticEvidenceBytes = Buffer.alloc(20, 1)
const publishedEvidenceFile = {
  relativePath: 'evidence/shot.png', digest: digest('b'), byteLength: 20,
  sanitizerOutputDigest: digestBytes('sanitizer-output/v1', semanticEvidenceBytes), bytes: semanticEvidenceBytes,
}

function artifact(overrides: Partial<AuditableArtifact> = {}): AuditableArtifact {
  return {
    artifactId: 'ARTIFACT-A', artifactType: 'project-policy', schemaVersion: '1.0.0',
    engineVersion: '1.0.0', assetId: 'ASSET-1', prdRevision: digest('a'), generationId: 'GEN-1',
    contentDigest: digest('b'), dependencies: [], graph: { defines: [], references: [] },
    ...overrides,
  }
}

describe('代际引用图审计', () => {
  test('接受同代、摘要闭合且引用可解析的图', () => {
    const source = artifact({ graph: { defines: [{ kind: 'REQ', id: 'REQ-1' }], references: [] } })
    const dependent = artifact({
      artifactId: 'ARTIFACT-B', artifactType: 'acceptance-scope', contentDigest: digest('c'),
      dependencies: [{ artifactId: source.artifactId, artifactType: source.artifactType,
        schemaVersion: source.schemaVersion, relativePath: 'artifacts/project-policy.json', digest: source.contentDigest }],
      graph: { defines: [], references: [{ kind: 'REQ', id: 'REQ-1' }] },
    })

    expect(auditArtifactGraph([source, dependent], new Map([
      [source.artifactId, 'artifacts/project-policy.json'],
      [dependent.artifactId, 'artifacts/acceptance-scope.json'],
    ]))).toEqual({ valid: true, findings: [] })
  })

  test('一次报告跨代、重复 ID、断链和依赖摘要错误', () => {
    const source = artifact({ graph: { defines: [{ kind: 'REQ', id: 'REQ-1' }], references: [] } })
    const corrupt = artifact({
      artifactId: 'ARTIFACT-B', artifactType: 'acceptance-scope', generationId: 'GEN-2',
      dependencies: [{ artifactId: source.artifactId, artifactType: source.artifactType,
        schemaVersion: source.schemaVersion, relativePath: 'wrong.json', digest: digest('f') }],
      graph: {
        defines: [{ kind: 'REQ', id: 'REQ-1' }],
        references: [{ kind: 'RULE', id: 'RULE-MISSING' }],
      },
    })

    const result = auditArtifactGraph([source, corrupt], new Map([
      [source.artifactId, 'artifacts/project-policy.json'], [corrupt.artifactId, 'artifacts/acceptance-scope.json'],
    ]))
    expect(result.valid).toBe(false)
    expect(result.findings.map((finding) => finding.code)).toEqual(expect.arrayContaining([
      'E2E_GENERATION_CROSS_GENERATION', 'E2E_GENERATION_DUPLICATE_ID',
      'E2E_GENERATION_REFERENCE_BROKEN', 'E2E_GENERATION_DEPENDENCY_DIGEST_MISMATCH',
      'E2E_GENERATION_DEPENDENCY_PATH_MISMATCH',
    ]))
  })
})

describe('代际文件登记审计', () => {
  const registered = [
    { relativePath: 'artifacts/project-policy.json', digest: digest('a'), byteLength: 12 },
    publishedEvidenceFile,
  ]

  test('允许明确排除的 journal、lock、quarantine，不允许普通未登记文件', () => {
    const actual = [
      ...registered,
      { relativePath: 'journal.json', digest: digest('c'), byteLength: 1 },
      { relativePath: 'lock/owner', digest: digest('d'), byteLength: 1 },
      { relativePath: 'quarantine/raw.bin', digest: digest('e'), byteLength: 1 },
      { relativePath: 'generation-manifest.json', digest: digest('f'), byteLength: 1 },
    ]
    expect(auditGenerationFiles(registered, actual)).toEqual({ valid: true, findings: [] })

    const result = auditGenerationFiles(registered, [
      ...actual, { relativePath: 'reports/hidden.json', digest: digest('f'), byteLength: 1 },
    ])
    expect(result.findings.map((finding) => finding.code)).toContain('E2E_GENERATION_FILE_UNREGISTERED')
  })

  test('拒绝缺失、摘要错误、大小错误、重复和不安全路径', () => {
    const result = auditGenerationFiles([
      ...registered,
      publishedEvidenceFile,
      { relativePath: '../escape', digest: digest('f'), byteLength: 1 },
    ], [
      { relativePath: 'artifacts/project-policy.json', digest: digest('f'), byteLength: 13 },
    ])
    expect(result.findings.map((finding) => finding.code)).toEqual(expect.arrayContaining([
      'E2E_GENERATION_FILE_DUPLICATE', 'E2E_GENERATION_FILE_PATH_INVALID',
      'E2E_GENERATION_FILE_MISSING', 'E2E_GENERATION_FILE_DIGEST_MISMATCH',
      'E2E_GENERATION_FILE_SIZE_MISMATCH',
    ]))
  })

  test('从真实目录 fd 计算摘要并拒绝符号链接', async () => {
    const root = await mkdtemp(join(tmpdir(), 'e2e-generation-audit-'))
    try {
      await writeFile(join(root, 'fact.json'), '{"ok":true}', 'utf8')
      const files = await collectGenerationFiles(root)
      expect(files).toEqual([{
        relativePath: 'fact.json',
        digest: digestText('generation-file:fact.json', '{"ok":true}'),
        sanitizerOutputDigest: digestBytes('sanitizer-output/v1', Buffer.from('{"ok":true}', 'utf8')),
        bytes: Buffer.from('{"ok":true}', 'utf8'),
        byteLength: 11,
      }])
      await symlink(join(root, 'fact.json'), join(root, 'link.json'))
      await expect(collectGenerationFiles(root)).rejects.toMatchObject({ code: 'E2E_GENERATION_SYMLINK_FORBIDDEN' })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('文件摘要按原始 bytes 计算，不对 NFD Unicode 做文本归一化', async () => {
    const root = await mkdtemp(join(tmpdir(), 'e2e-generation-unicode-'))
    const content = '{"title":"e\u0301"}'
    try {
      await writeFile(join(root, 'nfd.json'), content, 'utf8')
      const [file] = await collectGenerationFiles(root)
      expect(file?.digest).toBe(digestBytes('generation-file:nfd.json', Buffer.from(content, 'utf8')))
      expect(file?.digest).not.toBe(digestText('generation-file:nfd.json', content))
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe('最终结论独立复算', () => {
  const verdictInput: VerdictInput = {
    schemaVersion: '2.1.0', assetId: 'ASSET-1', generationId: 'GEN-1', verdictRuleVersion: '2.0.0',
    policyDigest: digest('1'), universeDigest: digest('2'), prdRevision: digest('a'),
    requirementModelDigest: digest('3'),
    obligations: [{ obligationId: 'COV-1', necessity: 'required', disposition: 'automated', caseIds: ['CASE-1'] }],
    caseResults: [{
      resultId: deriveExecutionResultId('CASE-1', 'real-environment'),
      caseId: 'CASE-1', runId: 'RUN-1', obligationIds: ['COV-1'], status: 'passed',
      executionMode: 'real-environment',
      attemptSelection: { status: 'valid', attemptId: 'ATTEMPT-1', eventChainDigest: digest('4') },
    }],
    manualResults: [], pendingDecisionIds: [], safetyFindings: [], artifactFindings: [],
    migrationFindings: [], environmentFindings: [], automationFindings: [],
    gatewayAudit: { status: 'valid', required: true, reasonCodes: [] },
    evidenceAudit: { status: 'complete', total: 1, complete: 1, reasonCodes: [] },
    cleanupAudit: { status: 'complete', total: 0, complete: 0, reasonCodes: [] },
    coverageFacts: {
      prdClauses: { covered: 1, total: 1 },
      requirementDesign: { covered: 1, total: 1 }, rules: { covered: 1, total: 1 },
      oracles: { covered: 1, total: 1 }, cases: { covered: 1, total: 1 },
      criticalNodes: { covered: 1, total: 1 }, roles: { covered: 1, total: 1 },
      stateTransitions: { covered: 0, total: 0 }, scenarioCategories: { covered: 1, total: 1 },
    },
  }
  const dependencies = { verifyAttemptSelection: () => true }

  test('逐字段接受重新计算出的 verdict 与全部指标', () => {
    const reported = computeVerdict(verdictInput, dependencies)
    expect(auditFinalVerdict(verdictInput, reported, dependencies)).toEqual({ valid: true, findings: [] })
  })

  test('拒绝报告层篡改 verdict 或任一指标', () => {
    const reported = computeVerdict(verdictInput, dependencies)
    const result = auditFinalVerdict(verdictInput, {
      ...reported,
      metrics: { ...reported.metrics, evidenceCompleteness: {
        status: 'value', numerator: 0, denominator: 1, percentage: 0,
      } },
    }, dependencies)
    expect(result).toEqual({
      valid: false,
      findings: [
        { code: 'E2E_GENERATION_VERDICT_RECOMPUTE_MISMATCH', path: 'metrics.evidenceCompleteness.numerator' },
        { code: 'E2E_GENERATION_VERDICT_RECOMPUTE_MISMATCH', path: 'metrics.evidenceCompleteness.percentage' },
      ],
    })
  })

  test('完整入口对畸形 VerdictInput fail-closed，而不是抛 TypeError', () => {
    const reported = computeVerdict(verdictInput, dependencies)
    const finalReport = {
      artifactId: 'FINAL-REPORT', artifactType: 'final-report', schemaVersion: '2.0.0',
      engineVersion: '1.0.0', assetId: 'ASSET-1', prdRevision: digest('a'), generationId: 'GEN-1',
      createdAt: '2026-07-11T10:00:00.000Z', contentDigest: digest('a'), signatures: [], dependencies: [],
      graph: { defines: [], references: [] },
      content: {
        verdictRuleVersion: reported.verdictRuleVersion, verdictInputDigest: digest('1'),
        verdict: reported.verdict, reasonCodes: reported.reasonCodes, cannotClaim: reported.cannotClaim,
        businessFailuresObserved: reported.businessFailuresObserved, advisoryFailures: reported.advisoryFailures,
        metrics: reported.metrics, scope: [], traceability: [], realResults: [], injectionResults: [],
        manualResults: [], risks: [], regression: { manifestDigest: digest('2'), command: 'playwright test' },
        title: '畸形 VerdictInput 审计报告',
        summaries: {
          prdId: 'PRD-1', prdTitle: '测试 PRD', scopeDigest: digest('1'),
          executionContractDigest: digest('2'), approvalGrantDigests: [], generationDigest: digest('3'),
        },
        approvals: [
          { kind: 'scope', status: 'approved', subjectDigest: digest('1'), grantDigests: [] },
          { kind: 'lineage', status: 'approved', subjectDigest: digest('6'), grantDigests: [] },
          { kind: 'execution', status: 'approved', subjectDigest: digest('2'), grantDigests: [] },
        ],
        environment: {
          environmentId: 'TEST', origins: ['https://example.test'],
          browser: { name: 'chromium', version: '1.0.0', channel: 'chromium' },
          roles: [], dataLeases: [],
        },
        dispositions: [], coverageUniverse: { universeDigest: digest('5'), obligations: [] },
        traceabilityMatrix: [], caseDetails: [],
        injectionBoundary: '没有注入 Case。',
        gatewayAudit: {
          status: 'not-required', digest: digest('4'), forwarded: 0, blocked: 0, injected: 0, findings: [],
        },
        browserHealth: [], diagnostics: [], sideEffects: [],
        regressionDetails: {
          testDomain: 'prd-e2e-trusted-compiler', executionProfile: 'trusted-read-only',
          generationId: 'GEN-1', manifestDigest: digest('2'), command: 'playwright test', caseIds: [],
          trustedCompiler: {
            compilerInputDigest: digest('1'), compilerVersion: '4.0.0', compilerDigest: digest('2'),
            templateVersion: '3.0.0', templateDigest: digest('3'), sourceSetDigest: digest('4'),
            discoverySignedDigest: digest('5'), nodeVersion: '24.0.0', playwrightVersion: '1.61.1',
            playwrightCliDigest: digest('6'),
            executionDigest: digest('7'),
          },
        },
        recommendations: [],
      },
    }
    const result = validateGeneration({
      artifactCandidates: [finalReport], artifactPaths: { 'FINAL-REPORT': 'run/final-report.json' },
      actualFiles: [], verdictInput: {} as VerdictInput,
    })
    expect(result.findings.map((finding) => finding.code)).toContain('E2E_GENERATION_VERDICT_INPUT_INVALID')
  })
})

describe('业务资产闭包审计', () => {
  const bundleDigest = digest('8')
  const sanitizationRecord = {
    schemaVersion: '1.0.0', evidenceType: 'dom', sanitizerVersion: '1.0.0', policyDigest: digest('5'),
    outputDigest: digestBytes('sanitizer-output/v1', semanticEvidenceBytes), formatCompatibility: { status: 'compatible' },
    scanResult: { status: 'clean' }, manualReview: { required: false, status: 'not-required' },
  }
  const sanitizerRecordDigest = digestText('sanitization-record/v1', canonicalizeJson(sanitizationRecord))
  const sanitizerAttestation = {
    schemaVersion: '1.0.0', issuer: 'sanitizer', keyId: 'sanitizer-key', purpose: 'sanitizer-attestation/v1',
    algorithm: 'Ed25519', evidenceId: 'EVIDENCE-1', relativePath: 'evidence/shot.png', evidenceType: 'dom',
    sanitizerVersion: '1.0.0', recordDigest: sanitizerRecordDigest, outputDigest: sanitizationRecord.outputDigest,
    policyDigest: digest('5'), fileDigest: digestBytes('generation-file:evidence/shot.png', semanticEvidenceBytes),
    sanitizedBytesDigest: digestBytes('sanitizer-output/v1', semanticEvidenceBytes), signedDigest: digest('a'), signature: 'valid',
  }
  const sanitizerProofDigest = digestText('sanitizer-attestation/v1', canonicalizeJson(sanitizerAttestation))
  const privacyReviewDigest = digestText('privacy-review-not-required/v1', canonicalizeJson({
    evidenceId: 'EVIDENCE-1', recordDigest: sanitizerRecordDigest, sanitizerProofDigest,
    policyDigest: digest('5'), status: 'not-required',
  }))
  const privacySignature = {
    issuer: 'local-authority', keyId: 'privacy-key', algorithm: 'Ed25519',
    signedDigest: privacyReviewDigest, signature: 'valid-signature',
  }
  const gatewayInstance = { instanceId: 'GATEWAY-1', version: '1.0.0', publicKeyDigest: digest('6') }
  const gatewayEvents = [
    { sequence: 0, actionId: 'ACTION-1', decision: 'forwarded', digest: digest('7') },
    { sequence: 1, actionId: 'ACTION-2', decision: 'blocked', digest: digest('6') },
  ]
  const reservationCores = [
    { reservationId: 'RESERVATION-1', grantId: 'GRANT-1', capabilityId: 'CAPABILITY-1',
      actionId: 'ACTION-1', attemptId: 'ATTEMPT-1', status: 'completed', outcomeDigest: digest('7'),
      reservedAt: '2026-07-11T10:00:00.000Z' },
    { reservationId: 'RESERVATION-2', grantId: 'GRANT-1', capabilityId: 'CAPABILITY-2',
      actionId: 'ACTION-2', attemptId: 'ATTEMPT-2', status: 'reserved',
      reservedAt: '2026-07-11T10:00:00.000Z' },
  ]
  const gatewayReservations = reservationCores.map((reservation, index) => {
    const consumed = index === 0
    return { ...reservation, consumed, digest: digestText('gateway-capability-reservation/v1', canonicalizeJson({
      reservation, consumed,
    })) }
  })
  const gatewayCounterDigest = digestText('gateway-audit-counters/v1', canonicalizeJson({
    gatewayInstance, policyDigest: digest('5'), forwarded: 1, blocked: 1, injected: 0,
    requestEvents: gatewayEvents, capabilityReservations: gatewayReservations,
  }))
  const semanticDependencies = {
    verifySanitizerAttestation: () => true,
    verifyPrivacyReviewReceipt: () => true,
    verifyGatewayAuditSignature: (signature: { signedDigest: string }) => {
      expect(signature.signedDigest).toBe(gatewayCounterDigest)
      return true
    },
  }
  const semanticArtifacts: SemanticArtifact[] = [
    { artifactId: 'PRD', artifactType: 'prd-manifest', content: { clauses: [{ clauseId: 'CLAUSE-1' }] } },
    { artifactId: 'POLICY', artifactType: 'project-policy', content: {
      browserMatrix: [{ browserId: 'CHROMIUM', channel: 'chrome', required: true }],
    } },
    { artifactId: 'EXECUTION', artifactType: 'execution-contract', content: {
      browserMatrix: [{ browserId: 'CHROMIUM', channel: 'chrome', viewportId: 'DESKTOP' }],
    } },
    { artifactId: 'SCOPE', artifactType: 'acceptance-scope', content: {
      includedReqCandidates: [{ reqId: 'REQ-1', sourceRefs: ['CLAUSE-1'] }],
      clauseDispositions: [{ clauseId: 'CLAUSE-1', disposition: 'modeled', requirementIds: ['REQ-1'] }],
    } },
    { artifactId: 'MODEL', artifactType: 'requirement-model', content: { requirements: [
      { reqId: 'REQ-1', status: 'active', sourceRefs: ['CLAUSE-1'], actors: [], transitions: [],
        rules: [{ ruleId: 'RULE-1', sourceRefs: ['CLAUSE-1'], oracleIds: ['ORACLE-1'] }],
        observableOutcomes: [{ oracleId: 'ORACLE-1', ruleId: 'RULE-1', sourceRefs: ['CLAUSE-1'] }] },
    ] } },
    { artifactId: 'COVERAGE', artifactType: 'coverage-universe', content: { obligations: [{
      obligationId: 'COV-1', reqId: 'REQ-1', clauseIds: ['CLAUSE-1'], ruleIds: ['RULE-1'],
      oracleIds: ['ORACLE-1'], necessity: 'required',
      disposition: { kind: 'automated', caseIds: ['CASE-1'] },
    }] } },
    { artifactId: 'CASES', artifactType: 'test-cases', content: { cases: [{
      caseId: 'CASE-1', obligationIds: ['COV-1'], steps: [{ stepId: 'STEP-1',
        oracles: [{ oracleId: 'ORACLE-1' }] }], status: 'active', evidenceLevel: 'E1',
    }] } },
    { artifactId: 'MAP', artifactType: 'browser-action-map', content: { actions: [{
      caseId: 'CASE-1', stepId: 'STEP-1', actionId: 'ACTION-1', oracleIds: ['ORACLE-1'], effect: 'read',
      capabilityId: 'CAPABILITY-1',
    }] } },
    { artifactId: 'BUNDLE', artifactType: 'run-bundle', contentDigest: bundleDigest, content: {
      schedule: [{ caseId: 'CASE-1', stepIds: ['STEP-1'], actionIds: ['ACTION-1'] }],
      signedCapabilities: [{ capabilityId: 'CAPABILITY-1', digest: digest('8') }],
    } },
    { artifactId: 'GRANTS', artifactType: 'approval-grants', content: { approvalSubjectDigest: bundleDigest } },
    { artifactId: 'RESULTS', artifactType: 'browser-results', content: { runId: 'RUN-1', executedBrowserIds: ['CHROMIUM'], caseResults: [{
      resultId: deriveExecutionResultId('CASE-1', 'real-environment'),
      caseId: 'CASE-1', attemptId: 'ATTEMPT-1', eventChainDigest: digest('4'),
      mode: 'real-environment', status: 'passed', stepResults: [{ stepId: 'STEP-1', actionId: 'ACTION-1', status: 'passed',
        actualDigest: digest('9'), oracleResult: 'passed', evidenceIds: ['EVIDENCE-1'] }],
    }] } },
    { artifactId: 'MANUAL', artifactType: 'manual-results', content: { results: [] } },
    { artifactId: 'EVIDENCE', artifactType: 'browser-evidence', content: { artifacts: [{
      evidenceId: 'EVIDENCE-1', caseId: 'CASE-1', relativePath: 'evidence/shot.png',
      digest: digest('b'), byteLength: 20, evidenceLevel: 'E1', sanitizationRecord,
    }], sanitizerProofs: [{ evidenceId: 'EVIDENCE-1', record: sanitizationRecord, attestation: sanitizerAttestation }],
    privacyReviews: [{ evidenceId: 'EVIDENCE-1', status: 'not-required',
      derivationDigest: privacyReviewDigest }] } },
    { artifactId: 'GATEWAY', artifactType: 'gateway-audit', content: {
      gatewayInstance, policyDigest: digest('5'), requestEvents: gatewayEvents,
      capabilityReservations: gatewayReservations,
      signedCounters: { forwarded: 1, blocked: 1, injected: 0, digest: gatewayCounterDigest,
        signature: { ...privacySignature, signedDigest: gatewayCounterDigest } },
    } },
    { artifactId: 'LEASES', artifactType: 'data-leases', content: { leases: [{ leaseId: 'LEASE-1', status: 'released' }] } },
    { artifactId: 'CLEANUP', artifactType: 'cleanup-results', content: { leaseResults: [{ leaseId: 'LEASE-1', status: 'verified-clean' }] } },
    { artifactId: 'REGRESSION', artifactType: 'regression-manifest', content: {
      caseMappings: [{ caseId: 'CASE-1' }], listResult: { caseIds: ['CASE-1'] },
    } },
  ]

  test('接受从需求到证据、清理和回归清单的完整闭包', () => {
    expect(auditArtifactSemantics(semanticArtifacts, [
      publishedEvidenceFile,
    ], semanticDependencies)).toEqual({ valid: true, findings: [] })
  })

  test('failed Case 也必须完整覆盖计划中的全部 Step 与 Action', () => {
    const incomplete = structuredClone(semanticArtifacts)
    const cases = incomplete.find((item) => item.artifactType === 'test-cases')!.content as any
    cases.cases[0].steps.push({ stepId: 'STEP-2' })
    const actionMap = incomplete.find((item) => item.artifactType === 'browser-action-map')!.content as any
    actionMap.actions.push({
      caseId: 'CASE-1', stepId: 'STEP-2', actionId: 'ACTION-2', oracleIds: ['ORACLE-2'], effect: 'read',
      capabilityId: 'CAPABILITY-2',
    })
    const bundle = incomplete.find((item) => item.artifactType === 'run-bundle')!.content as any
    bundle.schedule[0].stepIds.push('STEP-2')
    bundle.schedule[0].actionIds.push('ACTION-2')
    bundle.signedCapabilities.push({ capabilityId: 'CAPABILITY-2', digest: digest('7') })
    const result = incomplete.find((item) => item.artifactType === 'browser-results')!.content as any
    result.caseResults[0].status = 'failed'
    result.caseResults[0].stepResults[0].status = 'failed'
    result.caseResults[0].stepResults[0].oracleResult = 'failed'

    expect(auditArtifactSemantics(incomplete, [publishedEvidenceFile], semanticDependencies).findings
      .map((finding) => finding.code)).toContain('E2E_GENERATION_CASE_STATUS_DERIVATION_INVALID')
  })

  test('blocked Case 与可执行 mapping/list 互斥且仍闭合全部 active Case', () => {
    const artifacts = structuredClone(semanticArtifacts)
    const coverage = artifacts.find((item) => item.artifactType === 'coverage-universe')!.content as any
    coverage.obligations.push({ obligationId: 'COV-2', reqId: 'REQ-1', ruleIds: ['RULE-1'],
      necessity: 'required', disposition: { kind: 'automated', caseIds: ['CASE-2'] } })
    const cases = artifacts.find((item) => item.artifactType === 'test-cases')!.content as any
    cases.cases.push({ caseId: 'CASE-2', obligationIds: ['COV-2'],
      steps: [{ stepId: 'STEP-2' }], status: 'active', evidenceLevel: 'E1' })
    const actionMap = artifacts.find((item) => item.artifactType === 'browser-action-map')!.content as any
    actionMap.actions.push({ caseId: 'CASE-2', stepId: 'STEP-2', actionId: 'ACTION-2',
      oracleIds: ['ORACLE-2'], effect: 'read', capabilityId: 'CAPABILITY-2' })
    const regression = artifacts.find((item) => item.artifactType === 'regression-manifest')!.content as any
    regression.blockedCases = [{ caseId: 'CASE-2', reasonCode: 'E2E_COMPILER_ACTION_UNSUPPORTED' }]

    expect(auditArtifactSemantics(artifacts, [publishedEvidenceFile], semanticDependencies))
      .toEqual({ valid: true, findings: [] })

    regression.caseMappings.push({ caseId: 'CASE-2' })
    regression.listResult.caseIds.push('CASE-2')
    expect(auditArtifactSemantics(artifacts, [publishedEvidenceFile], semanticDependencies).findings
      .map((finding) => finding.code)).toEqual(expect.arrayContaining([
      'E2E_GENERATION_REGRESSION_CASE_MISMATCH',
      'E2E_GENERATION_PLAYWRIGHT_LIST_MISMATCH',
    ]))
  })

  test('拒绝 sequence 不严格等于事件索引的已重签网关审计', () => {
    const tampered = structuredClone(semanticArtifacts)
    const content = tampered.find((item) => item.artifactType === 'gateway-audit')!.content as any
    content.requestEvents[1].sequence = 0
    const resignedDigest = digestText('gateway-audit-counters/v1', canonicalizeJson({
      gatewayInstance: content.gatewayInstance,
      policyDigest: content.policyDigest,
      forwarded: 1,
      blocked: 1,
      injected: 0,
      requestEvents: content.requestEvents,
      capabilityReservations: content.capabilityReservations,
    }))
    content.signedCounters.digest = resignedDigest
    content.signedCounters.signature.signedDigest = resignedDigest

    expect(auditArtifactSemantics(tampered, [
      publishedEvidenceFile,
    ], {
      ...semanticDependencies,
      verifyGatewayAuditSignature: (signature) => signature.signedDigest === resignedDigest,
    }).findings.map((finding) => finding.code))
      .toContain('E2E_GENERATION_GATEWAY_AUDIT_SIGNATURE_INVALID')
  })

  test('拒绝预约 digest 不唯一的已重签网关审计', () => {
    const tampered = structuredClone(semanticArtifacts)
    const content = tampered.find((item) => item.artifactType === 'gateway-audit')!.content as any
    content.capabilityReservations[1].digest = content.capabilityReservations[0].digest
    const resignedDigest = digestText('gateway-audit-counters/v1', canonicalizeJson({
      gatewayInstance: content.gatewayInstance,
      policyDigest: content.policyDigest,
      forwarded: 1,
      blocked: 1,
      injected: 0,
      requestEvents: content.requestEvents,
      capabilityReservations: content.capabilityReservations,
    }))
    content.signedCounters.digest = resignedDigest
    content.signedCounters.signature.signedDigest = resignedDigest

    expect(auditArtifactSemantics(tampered, [
      publishedEvidenceFile,
    ], {
      ...semanticDependencies,
      verifyGatewayAuditSignature: (signature) => signature.signedDigest === resignedDigest,
    }).findings.map((finding) => finding.code))
      .toContain('E2E_GENERATION_GATEWAY_AUDIT_SIGNATURE_INVALID')
  })

  test.each([
    ['事件顺序', (content: any) => content.requestEvents.reverse()],
    ['事件字段', (content: any) => { content.requestEvents[0].actionId = 'ACTION-TAMPERED' }],
    ['事件删除', (content: any) => content.requestEvents.splice(1, 1)],
    ['预约字段', (content: any) => { content.capabilityReservations[0].consumed = false }],
    ['重复预约', (content: any) => content.capabilityReservations.push(
      structuredClone(content.capabilityReservations[0]),
    )],
  ])('拒绝签名后发生%s变化的网关审计数组', (_label, mutate) => {
    const tampered = structuredClone(semanticArtifacts)
    const gatewayContent = tampered.find((item) => item.artifactType === 'gateway-audit')!.content as any
    mutate(gatewayContent)

    expect(auditArtifactSemantics(tampered, [
      publishedEvidenceFile,
    ], semanticDependencies).findings.map((finding) => finding.code))
      .toContain('E2E_GENERATION_GATEWAY_AUDIT_SIGNATURE_INVALID')
  })

  test.each(['forwarded', 'blocked', 'injected'] as const)(
    '拒绝发布的 signedCounters.%s 与事件重算不一致',
    (counter) => {
      const tampered = structuredClone(semanticArtifacts)
      const content = tampered.find((item) => item.artifactType === 'gateway-audit')!.content as any
      content.signedCounters[counter] += 1

      expect(auditArtifactSemantics(tampered, [
        publishedEvidenceFile,
      ], semanticDependencies).findings.map((finding) => finding.code))
        .toContain('E2E_GENERATION_GATEWAY_AUDIT_SIGNATURE_INVALID')
    },
  )

  test('拒绝 signedCounters.digest 与独立重算不一致', () => {
    const tampered = structuredClone(semanticArtifacts)
    const content = tampered.find((item) => item.artifactType === 'gateway-audit')!.content as any
    content.signedCounters.digest = digest('0')

    expect(auditArtifactSemantics(tampered, [
      publishedEvidenceFile,
    ], semanticDependencies).findings.map((finding) => finding.code))
      .toContain('E2E_GENERATION_GATEWAY_AUDIT_SIGNATURE_INVALID')
  })

  test('拒绝 signature.signedDigest 与独立重算不一致', () => {
    const tampered = structuredClone(semanticArtifacts)
    const content = tampered.find((item) => item.artifactType === 'gateway-audit')!.content as any
    content.signedCounters.signature.signedDigest = digest('0')

    expect(auditArtifactSemantics(tampered, [
      publishedEvidenceFile,
    ], semanticDependencies).findings.map((finding) => finding.code))
      .toContain('E2E_GENERATION_GATEWAY_AUDIT_SIGNATURE_INVALID')
  })

  test('拒绝 Gateway verifier 返回 false', () => {
    expect(auditArtifactSemantics(semanticArtifacts, [
      publishedEvidenceFile,
    ], {
      ...semanticDependencies,
      verifyGatewayAuditSignature: () => false,
    }).findings.map((finding) => finding.code))
      .toContain('E2E_GENERATION_GATEWAY_AUDIT_SIGNATURE_INVALID')
  })

  test('Gateway verifier 抛错时稳定报告 verifier error', () => {
    const codes = auditArtifactSemantics(semanticArtifacts, [
      publishedEvidenceFile,
    ], {
      ...semanticDependencies,
      verifyGatewayAuditSignature: () => { throw new Error('verification unavailable') },
    }).findings.map((finding) => finding.code)

    expect(codes).toContain('E2E_GENERATION_GATEWAY_AUDIT_VERIFIER_ERROR')
    expect(codes).not.toContain('E2E_GENERATION_GATEWAY_AUDIT_SIGNATURE_INVALID')
  })

  test('同时报告范围、执行、证据、审批、网关、清理和回归断链', () => {
    const corrupt = semanticArtifacts.map((artifact) => ({ ...artifact, content: structuredClone(artifact.content) }))
    ;(corrupt.find((item) => item.artifactType === 'coverage-universe')!.content as any).obligations = []
    ;(corrupt.find((item) => item.artifactType === 'test-cases')!.content as any).cases.push({
      caseId: 'CASE-1', obligationIds: ['COV-X'], steps: [{ stepId: 'STEP-1' }], status: 'active', evidenceLevel: 'E1',
    })
    ;(corrupt.find((item) => item.artifactType === 'browser-results')!.content as any).caseResults[0].stepResults[0] = {
      stepId: 'STEP-X', actionId: 'ACTION-X', status: 'passed', oracleResult: 'not-evaluated', evidenceIds: [],
    }
    ;(corrupt.find((item) => item.artifactType === 'approval-grants')!.content as any).approvalSubjectDigest = digest('0')
    ;(corrupt.find((item) => item.artifactType === 'gateway-audit')!.content as any).requestEvents = []
    ;(corrupt.find((item) => item.artifactType === 'gateway-audit')!.content as any).capabilityReservations = []
    ;(corrupt.find((item) => item.artifactType === 'cleanup-results')!.content as any).leaseResults = []
    ;(corrupt.find((item) => item.artifactType === 'regression-manifest')!.content as any).caseMappings = []
    ;(corrupt.find((item) => item.artifactType === 'browser-evidence')!.content as any).sanitizerProofs = []

    const result = auditArtifactSemantics(corrupt, [], semanticDependencies)
    expect(result.findings.map((finding) => finding.code)).toEqual(expect.arrayContaining([
      'E2E_GENERATION_REQUIREMENT_COVERAGE_BROKEN', 'E2E_GENERATION_RESULT_REFERENCE_INVALID',
      'E2E_GENERATION_DUPLICATE_ID',
      'E2E_GENERATION_RESULT_INCOMPLETE', 'E2E_GENERATION_APPROVAL_SUBJECT_MISMATCH',
      'E2E_GENERATION_GATEWAY_COVERAGE_INCOMPLETE', 'E2E_GENERATION_CLEANUP_COVERAGE_INCOMPLETE',
      'E2E_GENERATION_REGRESSION_CASE_MISMATCH',
      'E2E_GENERATION_EVIDENCE_FILE_MISSING',
      'E2E_GENERATION_SANITIZER_PROOF_MISSING',
    ]))
  })

  test('拒绝用其他 Case 的合法 Step/Action 冒充当前 Case 结果', () => {
    const crossCase = structuredClone(semanticArtifacts)
    ;(crossCase.find((item) => item.artifactType === 'test-cases')!.content as any).cases.push({
      caseId: 'CASE-2', obligationIds: ['COV-1'], steps: [{ stepId: 'STEP-2' }],
      status: 'active', evidenceLevel: 'E1',
    })
    ;(crossCase.find((item) => item.artifactType === 'browser-action-map')!.content as any).actions.push({
      caseId: 'CASE-2', stepId: 'STEP-2', actionId: 'ACTION-2', oracleIds: ['ORACLE-2'], effect: 'read',
    })
    ;(crossCase.find((item) => item.artifactType === 'run-bundle')!.content as any).schedule.push({
      caseId: 'CASE-2', stepIds: ['STEP-2'], actionIds: ['ACTION-2'],
    })
    ;(crossCase.find((item) => item.artifactType === 'browser-results')!.content as any).caseResults[0].stepResults[0]
      = { stepId: 'STEP-2', actionId: 'ACTION-2', status: 'passed', actualDigest: digest('9'),
        oracleResult: 'passed', evidenceIds: ['EVIDENCE-1'] }

    expect(auditArtifactSemantics(crossCase, [
      publishedEvidenceFile,
    ], semanticDependencies).findings.map((finding) => finding.code)).toContain('E2E_GENERATION_RESULT_REFERENCE_INVALID')
  })

  test('拒绝证据等级不足或 sanitizer proof 与记录不一致', () => {
    const unsafe = structuredClone(semanticArtifacts)
    ;(unsafe.find((item) => item.artifactType === 'test-cases')!.content as any).cases[0].evidenceLevel = 'E3'
    ;(unsafe.find((item) => item.artifactType === 'browser-evidence')!.content as any).sanitizerProofs[0].record.outputDigest = digest('0')
    ;(unsafe.find((item) => item.artifactType === 'browser-evidence')!.content as any).artifacts[0].caseId = 'CASE-OTHER'
    const codes = auditArtifactSemantics(unsafe, [
      publishedEvidenceFile,
    ], semanticDependencies).findings.map((finding) => finding.code)
    expect(codes).toEqual(expect.arrayContaining([
      'E2E_GENERATION_EVIDENCE_LEVEL_INSUFFICIENT', 'E2E_GENERATION_SANITIZER_PROOF_BINDING_MISMATCH',
      'E2E_GENERATION_EVIDENCE_CASE_MISMATCH',
    ]))
    expect(auditArtifactSemantics(semanticArtifacts, [publishedEvidenceFile], {
      verifySanitizerAttestation: () => false,
    }).findings.map((finding) => finding.code)).toContain('E2E_GENERATION_SANITIZER_PROOF_SIGNATURE_INVALID')
  })

  test('required evidence 只接受 pending sanitizer record + 专用 approved receipt；rejected/pending/自动改 approved 均阻断', () => {
    const required = structuredClone(semanticArtifacts)
    const evidence: any = required.find((item) => item.artifactType === 'browser-evidence')!.content
    evidence.artifacts[0].sanitizationRecord.manualReview = {
      required: true, status: 'pending', reasonCodes: ['E2E_PRIVACY_REVIEW_SCREENSHOT'],
    }
    evidence.sanitizerProofs[0].record = structuredClone(evidence.artifacts[0].sanitizationRecord)
    const attestation = evidence.sanitizerProofs[0].attestation
    attestation.recordDigest = digestText('sanitization-record/v1', canonicalizeJson(evidence.artifacts[0].sanitizationRecord))
    const proofDigest = digestText('sanitizer-attestation/v1', canonicalizeJson(attestation))
    const receipt = { schemaVersion: '1.0.0', issuer: 'AUTHORITY', keyId: 'PRIVACY-1',
      purpose: 'privacy-review-receipt/v1', algorithm: 'Ed25519', evidenceId: 'EVIDENCE-1',
      relativePath: 'evidence/shot.png', fileDigest: digest('b'), outputDigest: sanitizationRecord.outputDigest,
      sanitizerProofDigest: proofDigest, policyDigest: digest('5'), decision: 'approved',
      checkedAt: '2026-07-12T00:00:00.000Z', approver: { subject: 'alice', roles: ['privacy-approver'] },
      signedDigest: digest('c'), signature: 'dedicated-signature' }
    evidence.privacyReviews = [{ evidenceId: 'EVIDENCE-1', status: 'approved', receipt }]
    const approvedCodes = auditArtifactSemantics(required, [publishedEvidenceFile], {
      ...semanticDependencies, verifyPrivacyReviewReceipt: () => true,
    }).findings.map((finding) => finding.code)
    expect(approvedCodes).not.toEqual(expect.arrayContaining([
      'E2E_GENERATION_PRIVACY_REVIEW_INCOMPLETE', 'E2E_GENERATION_PRIVACY_REVIEW_REJECTED',
      'E2E_GENERATION_SANITIZER_PROOF_UNSAFE',
    ]))

    const rejected = structuredClone(required)
    const rejectedReview: any = (rejected.find((item) => item.artifactType === 'browser-evidence')!.content as any).privacyReviews[0]
    rejectedReview.status = 'rejected'; rejectedReview.receipt.decision = 'rejected'
    expect(auditArtifactSemantics(rejected, [publishedEvidenceFile], {
      ...semanticDependencies, verifyPrivacyReviewReceipt: () => true,
    }).findings.map((finding) => finding.code)).toContain('E2E_GENERATION_PRIVACY_REVIEW_REJECTED')

    const forgedRecord = structuredClone(required)
    ;(forgedRecord.find((item) => item.artifactType === 'browser-evidence')!.content as any)
      .artifacts[0].sanitizationRecord.manualReview.status = 'approved'
    expect(auditArtifactSemantics(forgedRecord, [publishedEvidenceFile], semanticDependencies)
      .findings.map((finding) => finding.code)).toContain('E2E_GENERATION_SANITIZER_PROOF_UNSAFE')
    expect(auditArtifactSemantics(required, [publishedEvidenceFile], {
      verifySanitizerAttestation: () => true,
    }).findings.map((finding) => finding.code)).toContain('E2E_GENERATION_PRIVACY_REVIEW_INCOMPLETE')
  })

  test('VerdictInput 的 obligation、CaseResult 和 ManualResult 必须来自本代事实', () => {
    const input = {
      obligations: [{
        obligationId: 'COV-1', necessity: 'required', disposition: 'automated', caseIds: ['CASE-1'],
      }],
      caseResults: [{
        resultId: deriveExecutionResultId('CASE-1', 'real-environment'),
        caseId: 'CASE-1', runId: 'RUN-1', obligationIds: ['COV-1'], status: 'passed',
        executionMode: 'real-environment',
        attemptSelection: { status: 'valid', attemptId: 'ATTEMPT-1', eventChainDigest: digest('4') },
      }],
      manualResults: [],
      pendingDecisionIds: [],
      safetyFindings: [], artifactFindings: [], migrationFindings: [],
      environmentFindings: [], automationFindings: [],
      coverageFacts: {
        prdClauses: { covered: 1, total: 1 },
        requirementDesign: { covered: 1, total: 1 }, rules: { covered: 1, total: 1 },
        oracles: { covered: 1, total: 1 }, cases: { covered: 1, total: 1 },
        criticalNodes: { covered: 0, total: 0 }, roles: { covered: 0, total: 0 },
        stateTransitions: { covered: 0, total: 0 }, scenarioCategories: { covered: 0, total: 0 },
      },
      gatewayAudit: { status: 'valid', required: true, reasonCodes: [] },
      evidenceAudit: { status: 'complete', total: 1, complete: 1, reasonCodes: [] },
      cleanupAudit: { status: 'complete', total: 1, complete: 1, reasonCodes: [] },
    } as unknown as VerdictInput
    expect(auditVerdictFactBinding(semanticArtifacts, input)).toEqual({ valid: true, findings: [] })
    expect(auditVerdictFactBinding(semanticArtifacts, {
      ...input, caseResults: [{ ...input.caseResults[0]!, caseId: 'CASE-FORGED' }],
    }).findings.map((finding) => finding.code)).toContain('E2E_GENERATION_VERDICT_CASE_RESULTS_MISMATCH')
  })
})

describe('完整 generation 审计入口', () => {
  test('cleanup v1 只迁移可证明语义，released/active/reserved 必须 migration-required', () => {
    expect(migrateCleanupResultsV1({ leaseResults: [
      { leaseId: 'LEASE-1', status: 'not-applicable', digest: digest('1') },
      { leaseId: 'LEASE-2', status: 'cleanup-failed', digest: digest('2') },
    ] })).toEqual({
      status: 'migrated', schemaVersion: '2.0.0', content: { leaseResults: [
        { leaseId: 'LEASE-1', status: 'not-needed', digest: digest('1') },
        { leaseId: 'LEASE-2', status: 'failed', digest: digest('2') },
      ] },
    })
    for (const status of ['released', 'active', 'reserved']) {
      expect(migrateCleanupResultsV1({ leaseResults: [
        { leaseId: 'LEASE-1', status, digest: digest('1') },
      ] })).toMatchObject({ status: 'migration-required' })
    }
  })

  test('approval-grants v1 一律 migration-required，不把扁平 metadata 猜成 Authority freshness', async () => {
    const { migrateApprovalGrantsV1 } = await import('../src/index.js')
    expect(migrateApprovalGrantsV1({
      schemaVersion: '1.0.0', approvalSubjectDigest: digest('1'),
      grants: [{ grantId: 'GRANT-1', digest: digest('2'), expiresAt: '2026-07-13T00:00:00.000Z',
        nonce: 'N', decisionMaker: 'D' }], revocationSequence: 0,
    })).toEqual({ status: 'migration-required', findings: [{
      code: 'APPROVAL_GRANTS_V1_FRESHNESS_PROOF_UNAVAILABLE', ref: 'approval-grants',
    }] })
  })

  test('project-policy v1 缺少 runtime policy 时一律 migration-required', async () => {
    const { migrateProjectPolicyV1 } = await import('../src/index.js')
    expect(migrateProjectPolicyV1({ schemaVersion: '1.0.0' })).toEqual({
      status: 'migration-required', findings: [{
        code: 'PROJECT_POLICY_V1_RUNTIME_POLICY_UNAVAILABLE', ref: 'project-policy',
      }],
    })
  })

  test('Authority 审计不得复用 VerdictInput 派生 helper，避免共同遗漏自证', async () => {
    const source = await readFile(new URL('../src/generation-audit.ts', import.meta.url), 'utf8')
    expect(source.match(/deriveAuthorityVerdictFacts\(/g)?.length).toBe(2)
  })

  test('不抛异常地拒绝缺失类型和无法通过单体 Schema 的候选', () => {
    const result = validateGeneration({
      artifactCandidates: [{ artifactType: 'project-policy' }],
      artifactPaths: {}, actualFiles: [],
    })
    expect(result.valid).toBe(false)
    expect(result.findings.map((finding) => finding.code)).toEqual(expect.arrayContaining([
      'E2E_GENERATION_ARTIFACT_SCHEMA_INVALID', 'E2E_GENERATION_ARTIFACT_TYPE_MISSING',
    ]))
  })


  test('finalization snapshot 与 generation root 对顺序稳定、对内容变化敏感', () => {
    const artifacts = [
      { artifactId: 'B', artifactType: 'final-report', relativePath: 'b.json', digest: digest('b') },
      { artifactId: 'A', artifactType: 'project-policy', relativePath: 'a.json', digest: digest('a') },
    ]
    const snapshot = computeFinalizationSnapshotDigest(artifacts)
    expect(computeFinalizationSnapshotDigest([...artifacts].reverse())).toBe(snapshot)
    const root = computeGenerationRootDigest({
      generationId: 'GEN-1', fencingToken: 1, finalizationSnapshotDigest: snapshot,
      artifacts, files: [{ relativePath: 'a.json', digest: digest('a'), byteLength: 1 }],
      terminalVerdict: 'accepted',
    })
    expect(computeGenerationRootDigest({
      generationId: 'GEN-1', fencingToken: 1, finalizationSnapshotDigest: snapshot,
      artifacts: [...artifacts].reverse(), files: [{ relativePath: 'a.json', digest: digest('a'), byteLength: 1 }],
      terminalVerdict: 'accepted',
    })).toBe(root)
    expect(computeGenerationRootDigest({
      generationId: 'GEN-1', fencingToken: 1, finalizationSnapshotDigest: snapshot,
      artifacts, files: [{ relativePath: 'a.json', digest: digest('a'), byteLength: 1 }],
      terminalVerdict: 'rejected',
    })).not.toBe(root)
  })
})
