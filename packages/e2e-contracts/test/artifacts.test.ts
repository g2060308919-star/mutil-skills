import { describe, expect, test } from 'vitest'
import {
  ApprovalCapabilityRecordSchema,
  BrowserActionMapV21ContentSchema,
  ExecutionContractV11ContentSchema,
  FullPlaywrightProgramSchema,
  WriteApprovalSubjectV2Schema,
  computeFullPlaywrightCleanupSourceDigest,
  computeFullPlaywrightSourceDigest,
  canonicalizeJson,
  digestBytes,
  digestRuntimeHttpBodyTemplate,
  digestText,
} from '../src/index.js'

const digest = (value: string) => `sha256:${value.repeat(64)}`

function program() {
  const source = 'await page.getByRole("button", { name: "Add" }).click()'
  const cleanupSource = 'await page.evaluate(() => localStorage.clear()); return "verified-clean"'
  return {
    schemaVersion: 'full-playwright/v1' as const,
    caseId: 'CASE-1',
    stepId: 'STEP-1',
    actionId: 'ACTION-1',
    source,
    sourceDigest: computeFullPlaywrightSourceDigest(source),
    cleanupSource,
    cleanupSourceDigest: computeFullPlaywrightCleanupSourceDigest(cleanupSource),
    dataLeaseId: 'LEASE-1',
    cleanupPlanId: 'CLEANUP-1',
    timeoutMs: 30_000,
    networkRequests: [{
      intentId: 'INTENT-1', method: 'POST', canonicalOrigin: 'https://example.test',
      exactPath: '/api/todos', query: [], payload: { kind: 'json' as const, digest: digest('a') },
      targetFingerprint: digest('b'), maxRequests: 1, expectedOrder: 1,
    }],
  }
}

describe('FullPlaywrightProgram', () => {
  test('capability record 只接受结构化 read、HTTP write 与 full-playwright write 分支', () => {
    const base = { capabilityId: 'CAP-1', actionId: 'ACTION-1', digest: digest('0') }
    for (const valid of [
      { ...base, operation: 'dom-read', effect: 'read', maxUses: 2 },
      { ...base, operation: 'http-request', effect: 'reversible-write', maxUses: 1 },
      { ...base, operation: 'full-playwright', effect: 'reversible-write', maxUses: 1 },
    ]) expect(ApprovalCapabilityRecordSchema.safeParse(valid).success, JSON.stringify(valid)).toBe(true)

    for (const invalid of [
      { ...base, operation: 'full-playwright', effect: 'read', maxUses: 1 },
      { ...base, operation: 'dom-read', effect: 'reversible-write', maxUses: 1 },
      { ...base, operation: 'http-request', effect: 'reversible-write', maxUses: 2 },
      { ...base, operation: 'full-playwright', effect: 'reversible-write', maxUses: 2 },
    ]) expect(ApprovalCapabilityRecordSchema.safeParse(invalid).success, JSON.stringify(invalid)).toBe(false)
  })

  test('冻结 case/action/step、lease、cleanup、timeout 与请求闭包', () => {
    const value = program()
    expect(FullPlaywrightProgramSchema.parse(value)).toEqual(value)
    for (const field of [
      'caseId', 'stepId', 'actionId', 'cleanupSource', 'dataLeaseId', 'cleanupPlanId', 'timeoutMs', 'networkRequests',
    ] as const) {
      expect(FullPlaywrightProgramSchema.safeParse({ ...value, [field]: undefined }).success, field).toBe(false)
    }
    expect(FullPlaywrightProgramSchema.safeParse({
      ...value, networkRequests: [{ ...value.networkRequests[0], method: 'post' }],
    }).success)
      .toBe(false)
    const tooManyRequests = Array.from({ length: 1_001 }, (_, index) => ({
      ...value.networkRequests[0]!, intentId: `INTENT-${index}`, expectedOrder: index + 1,
    }))
    expect(FullPlaywrightProgramSchema.safeParse({ ...value, networkRequests: tooManyRequests }).success).toBe(false)
  })

  test('拒绝 source 或 cleanup digest 与冻结源码不一致', () => {
    const value = program()
    expect(FullPlaywrightProgramSchema.safeParse({ ...value, sourceDigest: digest('c') }).success).toBe(false)
    expect(FullPlaywrightProgramSchema.safeParse({ ...value, cleanupSourceDigest: digest('d') }).success).toBe(false)
  })

  test('full Playwright body material 精确绑定 JSON、binary 与 secret template intent', () => {
    const value = program()
    const json = { title: 'approved', nested: { count: 1 } }
    const jsonDigest = digestText('http-json-payload/v1', canonicalizeJson(json))
    const binary = Buffer.from([0, 1, 2, 255])
    const binaryDigest = digestBytes('http-binary-payload/v1', binary)
    const segments = [{ kind: 'literal' as const, value: '{"token":"' },
      { kind: 'secretRef' as const, secretRef: 'TOKEN' }, { kind: 'literal' as const, value: '"}' }]
    const templateDigest = digestRuntimeHttpBodyTemplate({ kind: 'segments',
      contentType: 'application/json', segments })
    const requests = [
      { ...value.networkRequests[0]!, intentId: 'JSON', expectedOrder: 1,
        payload: { kind: 'json' as const, digest: jsonDigest } },
      { ...value.networkRequests[0]!, intentId: 'BINARY', expectedOrder: 2,
        payload: { kind: 'binary' as const, digest: binaryDigest } },
      { ...value.networkRequests[0]!, intentId: 'TEMPLATE', expectedOrder: 3,
        payload: { kind: 'template' as const, templateDigest } },
    ]
    const requestBodies = [
      { intentId: 'JSON', kind: 'json' as const, canonicalJson: canonicalizeJson(json) },
      { intentId: 'BINARY', kind: 'binary' as const, contentType: 'application/octet-stream',
        bodyBase64Url: binary.toString('base64url') },
      { intentId: 'TEMPLATE', kind: 'template' as const, contentType: 'application/json',
        segments, templateDigest },
    ]
    expect(FullPlaywrightProgramSchema.safeParse({ ...value, networkRequests: requests,
      networkRequestBodies: requestBodies }).success).toBe(true)
    expect(FullPlaywrightProgramSchema.safeParse({ ...value, networkRequests: requests,
      networkRequestBodies: requestBodies.map((body) => body.intentId === 'BINARY'
        ? { ...body, bodyBase64Url: Buffer.from('changed').toString('base64url') } : body) }).success).toBe(false)
    expect(FullPlaywrightProgramSchema.safeParse({ ...value, networkRequests: requests,
      networkRequestBodies: requestBodies.filter((body) => body.intentId !== 'TEMPLATE') }).success).toBe(false)
  })

  test('Execution Contract 与 Action Map 只在显式 full profile 下闭合投影', () => {
    const value = program()
    const cleanupPlan = {
      schemaVersion: '2.0.0' as const,
      transport: 'browser-local' as const,
      cleanupPlanId: value.cleanupPlanId,
      actionId: value.actionId,
      leaseId: value.dataLeaseId,
      executorId: 'FULL-PLAYWRIGHT' as const,
      cleanupProgramDigest: value.cleanupSourceDigest,
      cleanupRequestIntentIds: [],
      verificationProbes: [{
        probeId: 'CLEANUP-PROBE-1', kind: 'browser-observation' as const, expectedDigest: digest('4'),
      }],
      timeoutMs: value.timeoutMs,
    }
    const legacyCleanupPlan = {
      schemaVersion: '1.0.0' as const,
      cleanupPlanId: value.cleanupPlanId,
      actionId: value.actionId,
      leaseId: value.dataLeaseId,
      executorId: 'EXECUTOR-HTTP-CLEANUP',
      cleanupRequestIntentIds: ['INTENT-1'],
      verificationProbes: [{
        probeId: 'CLEANUP-PROBE-HTTP-1', kind: 'resource-state' as const, expectedDigest: digest('4'),
      }],
      timeoutMs: value.timeoutMs,
    }
    const executionContract = {
      environment: 'TEST', baseOrigin: 'https://example.test', executionProfile: 'full-playwright' as const,
      browserMatrix: [{ browserId: 'CHROMIUM', channel: 'chromium', viewportId: 'DESKTOP' }],
      identities: [], caseQueue: [{ ordinal: 0, caseId: 'CASE-1' }],
      actionIntents: [{ actionId: 'ACTION-1', effect: 'reversible-write' as const,
        intentDigest: digest('e'), requestIds: [] }],
      dataNeeds: [{ leaseId: 'LEASE-1', resourceKey: 'TODOS',
        resourceFingerprint: value.networkRequests[0]!.targetFingerprint, mode: 'write' as const }],
      manualProcedures: [], evidencePolicyDigest: digest('f'), runtimeIsolation: null,
      unresolvedItems: [], readHttpRequests: [], writeCleanupPlans: [cleanupPlan], fullPlaywrightPrograms: [value],
    }
    const actionMap = {
      actionMapRevision: 1, executionProfile: 'full-playwright' as const,
      pageIdentities: [{ pageId: 'PAGE-1', origin: 'https://example.test', assertionDigest: digest('1') }],
      actions: [{
        caseId: 'CASE-1', stepId: 'STEP-1', actionId: 'ACTION-1', pageIdentityId: 'PAGE-1',
        locatorCandidates: [], playwrightAction: 'full-playwright/v1', waits: [], oracleIds: ['ORACLE-1'],
        effect: 'reversible-write' as const,
        capabilities: [{ operation: 'full-playwright' as const, capabilityId: 'CAP-1' }], requestIds: [],
      }],
      unmappedSteps: [], discoveredRisks: [], fullPlaywrightPrograms: [value],
    }

    expect(ExecutionContractV11ContentSchema.parse(executionContract)).toEqual(executionContract)
    expect(ExecutionContractV11ContentSchema.safeParse({
      ...executionContract,
      writeCleanupPlans: [{ ...cleanupPlan, cleanupRequestIntentIds: ['INTENT-1'] }],
    }).success).toBe(true)
    expect(BrowserActionMapV21ContentSchema.parse(actionMap)).toEqual(actionMap)
    expect(ExecutionContractV11ContentSchema.safeParse({
      ...executionContract, executionProfile: 'trusted-reversible-write',
    }).success).toBe(false)
    expect(BrowserActionMapV21ContentSchema.safeParse({
      ...actionMap, fullPlaywrightPrograms: [{ ...value, stepId: 'STEP-OTHER' }],
    }).success).toBe(false)
    expect(BrowserActionMapV21ContentSchema.safeParse({
      ...actionMap,
      actions: [{ ...actionMap.actions[0],
        capabilities: [{ operation: 'dom-read', capabilityId: 'CAP-1' }] }],
    }).success).toBe(false)
    expect(ExecutionContractV11ContentSchema.safeParse({
      ...executionContract, dataNeeds: [],
    }).success).toBe(false)
    expect(ExecutionContractV11ContentSchema.safeParse({
      ...executionContract, writeCleanupPlans: undefined,
    }).success).toBe(false)
    expect(ExecutionContractV11ContentSchema.safeParse({
      ...executionContract,
      writeCleanupPlans: [{ ...cleanupPlan, actionId: 'ACTION-OTHER' }],
    }).success).toBe(false)
    expect(ExecutionContractV11ContentSchema.safeParse({
      ...executionContract,
      writeCleanupPlans: [{ ...cleanupPlan, leaseId: 'LEASE-OTHER' }],
    }).success).toBe(false)
    expect(ExecutionContractV11ContentSchema.safeParse({
      ...executionContract, writeCleanupPlans: [legacyCleanupPlan],
    }).success).toBe(false)
    expect(ExecutionContractV11ContentSchema.safeParse({
      ...executionContract,
      writeCleanupPlans: [{ ...cleanupPlan, executorId: 'EXECUTOR-OTHER' }],
    }).success).toBe(false)
    expect(ExecutionContractV11ContentSchema.safeParse({
      ...executionContract,
      writeCleanupPlans: [{ ...cleanupPlan, cleanupProgramDigest: digest('9') }],
    }).success).toBe(false)
    expect(ExecutionContractV11ContentSchema.safeParse({
      ...executionContract,
      writeCleanupPlans: [{ ...cleanupPlan, cleanupRequestIntentIds: ['INTENT-UNKNOWN'] }],
    }).success).toBe(false)
  })

  test('Write approval subject 严格区分旧 HTTP 与 browser-local 字段', () => {
    const value = program()
    const base = {
      schemaVersion: '2.0.0' as const, assetId: 'ASSET-1', prdRevision: digest('1'),
      executionDigest: digest('2'), scopeDigest: digest('3'), requirementModelDigest: digest('4'),
      coveragePolicyDigest: digest('5'), universeDigest: digest('6'), caseDigest: digest('7'),
      actionMapDigest: digest('8'), policyDigest: digest('9'), executionContractDigest: digest('a'),
      runBundleProjectionDigest: digest('b'), environment: 'test' as const,
      baseOrigin: 'https://example.test', actor: 'ACTOR-1', discoveryGrantId: 'GRANT-1',
      preflightDigest: digest('c'),
    }
    const browserAction = {
      actionId: value.actionId, transport: 'browser-local' as const, operation: 'full-playwright' as const,
      effect: 'reversible-write' as const, programDigest: value.sourceDigest,
      cleanupProgramDigest: value.cleanupSourceDigest, dataLeaseId: value.dataLeaseId,
      resourceKey: 'todos:fixture', fencingToken: 1, cleanupPlanDigest: digest('d'), requests: value.networkRequests,
    }
    const httpAction = {
      actionId: 'ACTION-HTTP', effect: 'reversible-write' as const, dataLeaseId: 'LEASE-HTTP',
      resourceKey: 'todos:http', fencingToken: 1, cleanupPlanDigest: digest('e'), requests: value.networkRequests,
    }

    expect(WriteApprovalSubjectV2Schema.safeParse({ ...base, actions: [browserAction] }).success).toBe(true)
    expect(WriteApprovalSubjectV2Schema.safeParse({ ...base, actions: [httpAction] }).success).toBe(true)
    expect(WriteApprovalSubjectV2Schema.safeParse({
      ...base, actions: [{ ...httpAction, transport: 'http', operation: 'http-request' }],
    }).success).toBe(false)
    expect(WriteApprovalSubjectV2Schema.safeParse({
      ...base, actions: [{ ...browserAction, operation: 'http-request' }],
    }).success).toBe(false)
    expect(WriteApprovalSubjectV2Schema.safeParse({
      ...base,
      actions: [{ ...browserAction, requests: Array.from({ length: 1_001 }, (_, index) => ({
        ...value.networkRequests[0]!, intentId: `INTENT-${index}`, expectedOrder: index + 1,
      })) }],
    }).success).toBe(false)
  })
})
