import { describe, expect, test } from 'vitest'
import {
  canonicalizeJson,
  CompilerInputV1Schema,
  computeCompilerInputDigest,
  computeFullPlaywrightCleanupSourceDigest,
  computeFullPlaywrightSourceDigest,
  digestCanonicalGrantApprovalSubject,
  digestText,
  type CompilerInputV1,
} from '../src/index.js'

const digest = (value: string) => `sha256:${value.repeat(64)}`

function compilerInput(): CompilerInputV1 {
  const subject = {
    schemaVersion: '2.1.0' as const, assetId: 'PRODUCT/PRD-1', prdRevision: digest('a'),
    scopeDigest: digest('d'), requirementModelDigest: digest('e'), coveragePolicyDigest: digest('f'),
    universeDigest: digest('1'), caseDigest: digest('2'), actionMapDigest: digest('3'),
    policyDigest: digest('c'), executionContractDigest: digest('4'), runBundleProjectionDigest: digest('5'),
    environment: 'test' as const, baseOrigin: 'https://example.test', actor: 'USER',
    discoveryGrantId: 'DISCOVERY-1', preflightDigest: digest('6'),
    requests: [],
    actions: [{ actionId: 'ACTION-1', operation: 'dom-read' as const, maxUses: 1, requestIds: [] }],
  }
  const capabilities = [{ capabilityId: 'CAP-1', actionId: 'ACTION-1', operation: 'dom-read' as const,
    effect: 'read' as const, maxUses: 1, digest: digest('7') }]
  const receiptBody = {
    schemaVersion: '1.0.0' as const, grantType: 'read' as const, grantId: 'GRANT-1',
    subjectDigest: digestCanonicalGrantApprovalSubject('execution', subject),
    runBundleDigest: digest('8'), browserPreflightArtifactDigest: digest('9'), capabilities,
    capabilitySetDigest: digestText('approval-capability-set/v1', canonicalizeJson(capabilities)),
    expiresAt: '2026-07-16T00:00:00.000Z', checkedAt: '2026-07-15T00:00:00.000Z',
    revocationSequence: 0, status: 'valid' as const, reasonCodes: [], executionSubjectSnapshot: subject,
  }
  return {
    schemaVersion: 'compiler-input/v1',
    assetId: 'PRODUCT/PRD-1',
    generationId: 'GEN-1',
    runId: 'RUN-1',
    prdRevision: digest('a'),
    scopeDigest: digest('d'),
    lineageDecisionDigest: digest('0'),
    contractsVersion: '2.0.0',
    environmentId: 'TEST',
    baseOrigin: 'https://example.test',
    approvalDigest: digest('b'),
    approvalFreshnessReceipt: { ...receiptBody, authorityProof: {
      purpose: 'approval-freshness-receipt/v1', issuer: 'AUTHORITY', keyId: 'FRESHNESS-1', algorithm: 'Ed25519',
      signedDigest: digestText('approval-freshness-receipt/v1', canonicalizeJson(receiptBody)), signature: 'fixture',
    } },
    policyDigest: digest('c'),
    playwrightVersion: '1.61.1',
    nodeVersion: '24.18.0',
    cases: [{
      caseId: 'CASE-1', title: '首页可见', reqIds: ['REQ-1'], ruleIds: ['RULE-1'],
      obligationIds: ['COV-1'], mode: 'real-environment',
      actions: [{ kind: 'assertText', actionId: 'ACTION-1', target: '首页', expected: '待审核' }],
    }],
    blockedCases: [{ caseId: 'CASE-2', reasonCode: 'E2E_COMPILER_ACTION_UNSUPPORTED' }],
  }
}

describe('CompilerInputV1', () => {
  test('只接受封闭声明式 Action，并稳定计算 canonical digest', () => {
    const input = compilerInput()
    expect(CompilerInputV1Schema.parse(input)).toEqual(input)
    expect(computeCompilerInputDigest(input)).toBe(computeCompilerInputDigest(structuredClone(input)))
    expect(CompilerInputV1Schema.safeParse({ ...input, sourceFiles: [{ bytes: 'process.env.HOME' }] }).success)
      .toBe(false)
    expect(CompilerInputV1Schema.safeParse({ ...input, cases: [{
      ...input.cases[0], actions: [{ kind: 'customCode', actionId: 'ACTION-1', source: 'process.env' }],
    }] }).success).toBe(false)
  })

  test('拒绝重复、未排序或 executable/blocked 重叠的 Case', () => {
    const input = compilerInput()
    expect(CompilerInputV1Schema.safeParse({ ...input, cases: [input.cases[0], input.cases[0]] }).success).toBe(false)
    expect(CompilerInputV1Schema.safeParse({ ...input, cases: [{ ...input.cases[0], reqIds: ['REQ-2', 'REQ-1'] }] }).success)
      .toBe(false)
    expect(CompilerInputV1Schema.safeParse({ ...input,
      blockedCases: [{ caseId: 'CASE-1', reasonCode: 'E2E_COMPILER_ACTION_UNSUPPORTED' }] }).success).toBe(false)
  })

  test('拒绝在同一密封项目混合只读与可逆写模板', () => {
    const input = compilerInput()
    expect(CompilerInputV1Schema.safeParse({ ...input, cases: [{ ...input.cases[0], actions: [
      ...input.cases[0].actions,
      { kind: 'reversibleWrite', actionId: 'ACTION-2', buttonName: '批准', beforeText: '待审核',
        afterText: '已批准', dataLeaseId: 'LEASE-1', cleanupPlanId: 'CLEANUP-1' },
    ] }] }).success).toBe(false)
  })

  test('full-playwright 必须显式选择并冻结 source、cleanup 与各自摘要', () => {
    const input = compilerInput()
    const source = 'await page.getByRole("textbox").fill("hello")'
    const cleanupSource = 'await page.getByRole("textbox").fill(""); return "verified-clean"'
    const fullAction = {
      kind: 'fullPlaywright' as const,
      actionId: 'ACTION-1',
      source,
      sourceDigest: computeFullPlaywrightSourceDigest(source),
      cleanupSource,
      cleanupSourceDigest: computeFullPlaywrightCleanupSourceDigest(cleanupSource),
      dataLeaseId: 'LEASE-1',
      cleanupPlanId: 'CLEANUP-1',
      timeoutMs: 30_000,
      cleanupTimeoutMs: 30_000,
    }
    const fullInput = {
      ...input,
      executionProfile: 'full-playwright' as const,
      cases: [{ ...input.cases[0], actions: [fullAction] }],
    }
    const typedFullInput: CompilerInputV1 = fullInput

    expect(CompilerInputV1Schema.parse(typedFullInput)).toEqual(fullInput)
    expect(CompilerInputV1Schema.safeParse({
      ...fullInput,
      cases: [{ ...fullInput.cases[0], actions: [{ ...fullAction, sourceDigest: digest('f') }] }],
    }).success).toBe(false)
    expect(CompilerInputV1Schema.safeParse({
      ...fullInput,
      cases: [{ ...fullInput.cases[0], actions: [{ ...fullAction, cleanupSource: undefined }] }],
    }).success).toBe(false)
    expect(CompilerInputV1Schema.safeParse({ ...fullInput, executionProfile: 'trusted-reversible-write' }).success)
      .toBe(false)
    expect(CompilerInputV1Schema.safeParse({ ...input, executionProfile: 'full-playwright' }).success)
      .toBe(false)
  })
})
