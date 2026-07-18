import { describe, expect, test } from 'vitest'
import {
  ArtifactSchemaRegistry,
  BrowserActionMapV21ContentSchema,
  DiscoveryApprovalSubjectSchema,
  LegacyDiscoveryApprovalSubjectV10Schema,
  LegacyReadApprovalSubjectV20Schema,
  ReadApprovalSubjectSchema,
  SignedGrantSchema,
  canonicalGrantApprovalSubjectDigest,
  migrateBrowserActionMapV20ToV21,
  migrateDiscoveryApprovalSubjectV10ToV11,
  migrateExecutionContractV10ToV11,
  migrateReadApprovalSubjectV20ToV21,
  parseArtifactDocument,
  validateReadHttpProtocolProjection,
} from '../src/index.js'

const digest = (character: string) => `sha256:${character.repeat(64)}`
const readRequest = {
  requestId: 'REQUEST-1', method: 'GET', url: 'https://example.test/api/orders',
  headers: [{ name: 'accept', value: 'application/json' }], bodyDigest: digest('0'),
  redirectPolicy: { mode: 'deny' as const },
}

function envelope(artifactType: 'execution-contract' | 'browser-action-map', schemaVersion: string, content: unknown) {
  return {
    artifactId: `ARTIFACT-${artifactType}`, artifactType, schemaVersion, engineVersion: '1.0.0',
    assetId: 'ASSET-1', prdRevision: digest('a'), generationId: 'GEN-1',
    createdAt: '2026-07-17T00:00:00.000Z', contentDigest: digest('b'), signatures: [],
    dependencies: [], graph: { defines: [], references: [] }, content,
  }
}

const executionV10 = {
  environment: 'test', baseOrigin: 'https://example.test',
  browserMatrix: [{ browserId: 'chromium', channel: 'chromium', viewportId: 'desktop' }],
  identities: [], caseQueue: [{ ordinal: 0, caseId: 'CASE-1' }],
  actionIntents: [{ actionId: 'ACTION-1', effect: 'read' as const, intentDigest: digest('1') }],
  dataNeeds: [], manualProcedures: [], evidencePolicyDigest: digest('2'),
  runtimeIsolation: null, unresolvedItems: [],
}

const actionMapV20 = {
  actionMapRevision: 1,
  pageIdentities: [{ pageId: 'PAGE-1', origin: 'https://example.test', assertionDigest: digest('3') }],
  actions: [{
    caseId: 'CASE-1', stepId: 'STEP-1', actionId: 'ACTION-1', pageIdentityId: 'PAGE-1',
    locatorCandidates: [{ strategy: 'role', value: 'main', confidence: 1 }],
    playwrightAction: 'page.goto', waits: [], oracleIds: ['ORACLE-1'], effect: 'read' as const,
    capabilities: [{ operation: 'dom-read' as const, capabilityId: 'CAP-1' }],
  }],
  unmappedSteps: [], discoveredRisks: [],
}

const discoveryV10 = {
  schemaVersion: '1.0.0' as const, assetId: 'ASSET-1', prdRevision: digest('a'),
  scopeDigest: digest('b'), environment: 'test' as const, baseOrigin: 'https://example.test', actor: 'USER',
  expectedPageIdentity: {
    url: 'https://example.test/orders', title: 'Orders', heading: 'Orders', ariaSignals: [],
  },
  bootstrapIntentsDigest: digest('c'),
  actions: [{ actionId: 'ACTION-1', operation: 'local-navigation' as const, maxUses: 1 }],
}

const readV20 = {
  schemaVersion: '2.0.0' as const, assetId: 'ASSET-1', prdRevision: digest('a'), scopeDigest: digest('b'),
  requirementModelDigest: digest('c'), coveragePolicyDigest: digest('d'), universeDigest: digest('e'),
  caseDigest: digest('f'), actionMapDigest: digest('1'), policyDigest: digest('2'),
  executionContractDigest: digest('3'), runBundleProjectionDigest: digest('4'),
  environment: 'test' as const, baseOrigin: 'https://example.test', actor: 'USER',
  discoveryGrantId: 'DISCOVERY-1', preflightDigest: digest('5'),
  actions: [{ actionId: 'ACTION-1', operation: 'local-navigation' as const, maxUses: 1 }],
}

describe('SPA/API 只读请求协议版本', () => {
  test('execution-contract 1.1 冻结完整请求；1.0 只能经显式补充事实迁移', () => {
    const migrated = migrateExecutionContractV10ToV11(
      executionV10, [readRequest], { 'ACTION-1': ['REQUEST-1'] },
    )
    const current = envelope('execution-contract', '1.1.0', migrated)
    expect(ArtifactSchemaRegistry['execution-contract'].parse(current)).toEqual(current)
    expect(() => parseArtifactDocument(
      envelope('execution-contract', '1.0.0', executionV10),
    )).toThrow('E2E_ARTIFACT_SCHEMA_MIGRATION_REQUIRED')
    expect(() => ArtifactSchemaRegistry['execution-contract'].parse({
      ...current, content: { ...migrated, unexpected: true },
    })).toThrow()
  })

  test('browser-action-map 2.1 只保存 requestId 引用，不接受内嵌请求或未知字段', () => {
    const migrated = migrateBrowserActionMapV20ToV21(actionMapV20, { 'ACTION-1': ['REQUEST-1'] })
    const current = envelope('browser-action-map', '2.1.0', migrated)
    expect(ArtifactSchemaRegistry['browser-action-map'].parse(current)).toEqual(current)
    expect(() => parseArtifactDocument(
      envelope('browser-action-map', '2.0.0', actionMapV20),
    )).toThrow('E2E_ARTIFACT_SCHEMA_MIGRATION_REQUIRED')
    expect(BrowserActionMapV21ContentSchema.safeParse({
      ...migrated,
      actions: [{ ...migrated.actions[0], request: readRequest }],
    }).success).toBe(false)
  })

  test('Discovery 1.1 与 ReadApproval 2.1 签完整请求且旧版不会被最新版解析器静默接受', () => {
    expect(LegacyDiscoveryApprovalSubjectV10Schema.parse(discoveryV10)).toEqual(discoveryV10)
    expect(LegacyReadApprovalSubjectV20Schema.parse(readV20)).toEqual(readV20)

    const discovery = migrateDiscoveryApprovalSubjectV10ToV11(
      discoveryV10, [readRequest], { 'ACTION-1': ['REQUEST-1'] },
    )
    const read = migrateReadApprovalSubjectV20ToV21(
      readV20, [readRequest], { 'ACTION-1': ['REQUEST-1'] },
    )
    expect(DiscoveryApprovalSubjectSchema.parse(discovery)).toEqual(discovery)
    expect(ReadApprovalSubjectSchema.parse(read)).toEqual(read)
    expect(DiscoveryApprovalSubjectSchema.safeParse(discoveryV10).success).toBe(false)
    expect(ReadApprovalSubjectSchema.safeParse(readV20).success).toBe(false)
    expect(DiscoveryApprovalSubjectSchema.safeParse({ ...discovery, unsignedHint: true }).success).toBe(false)
    expect(ReadApprovalSubjectSchema.safeParse({ ...read, requests: [{ ...readRequest, method: 'get' }] }).success)
      .toBe(false)
  })

  test('显式迁移拒绝缺失、多余或悬空的 action/request 映射', () => {
    expect(() => migrateBrowserActionMapV20ToV21(actionMapV20, {})).toThrow('E2E_READ_HTTP_MIGRATION_MAPPING')
    expect(() => migrateDiscoveryApprovalSubjectV10ToV11(
      discoveryV10, [readRequest], { 'ACTION-1': ['REQUEST-MISSING'] },
    )).toThrow('E2E_READ_HTTP_REQUEST_REFERENCE_UNKNOWN')
    expect(() => migrateReadApprovalSubjectV20ToV21(
      readV20, [readRequest], { 'ACTION-1': ['REQUEST-1'], 'ACTION-UNKNOWN': [] },
    )).toThrow('E2E_READ_HTTP_MIGRATION_MAPPING')
    expect(() => migrateExecutionContractV10ToV11(
      { ...executionV10, actionIntents: [
        ...executionV10.actionIntents,
        { actionId: 'ACTION-2', effect: 'read', intentDigest: digest('9') },
      ] },
      [readRequest],
      { 'ACTION-1': ['REQUEST-1'], 'ACTION-2': ['REQUEST-1'] },
    )).toThrow('E2E_READ_HTTP_REQUEST_REFERENCE_CARDINALITY')
  })

  test('Execution、Action Map 与审批主体必须保持一请求一 action 的完整同构投影', () => {
    const execution = migrateExecutionContractV10ToV11(
      executionV10, [readRequest], { 'ACTION-1': ['REQUEST-1'] },
    )
    const actionMap = migrateBrowserActionMapV20ToV21(actionMapV20, { 'ACTION-1': ['REQUEST-1'] })
    const subject = migrateReadApprovalSubjectV20ToV21(
      readV20, [readRequest], { 'ACTION-1': ['REQUEST-1'] },
    )
    expect(() => validateReadHttpProtocolProjection({
      executionContract: execution, browserActionMap: actionMap, approvalSubject: subject,
    })).not.toThrow()
    expect(() => validateReadHttpProtocolProjection({
      executionContract: execution,
      browserActionMap: { ...actionMap, actions: [{ ...actionMap.actions[0], requestIds: [] }] },
      approvalSubject: subject,
    })).toThrow('E2E_READ_HTTP_ACTION_REFERENCE_MISMATCH')
    expect(() => validateReadHttpProtocolProjection({
      executionContract: execution, browserActionMap: actionMap,
      approvalSubject: { ...subject, requests: [{ ...readRequest, url: 'https://example.test/api/admin' }] },
    })).toThrow('E2E_READ_HTTP_APPROVAL_REQUEST_SET_MISMATCH')
  })

  test('HTTP read capability 只能引用已由 Grant subject 完整签名的 requestId', () => {
    const subject = migrateReadApprovalSubjectV20ToV21(
      { ...readV20, actions: [{ actionId: 'ACTION-1', operation: 'local-navigation', maxUses: 1 }] },
      [readRequest], { 'ACTION-1': ['REQUEST-1'] },
    )
    subject.actions[0]!.operation = 'http-request'
    const subjectDigest = canonicalGrantApprovalSubjectDigest(subject)
    const grant = {
      grantId: 'GRANT-READ-HTTP', issuer: 'authority', keyId: 'key-1', proofScope: 'local-os-user',
      approver: { subject: 'local:user', roles: ['e2e-approver'] },
      approvalContext: {
        schemaVersion: '1.0.0', subject: 'local:user', runId: 'RUN-1', approvalType: 'execution',
        subjectDigest, installationDigest: digest('7'), origin: 'http://localhost:43210',
        issuedAt: '2026-07-17T00:00:00.000Z', expiresAt: '2026-07-17T00:05:00.000Z',
      },
      subject, subjectDigest, issuedAt: '2026-07-17T00:00:00.000Z',
      expiresAt: '2026-07-17T00:01:00.000Z',
      capabilities: [{
        capabilityId: 'CAP-READ-HTTP', nonce: 'a'.repeat(64), transport: 'http', effect: 'read',
        actionId: 'ACTION-1', operation: 'http-request', requestIds: ['REQUEST-1'], maxUses: 1,
      }],
      revocationSequence: 0, signature: 's'.repeat(86),
    }
    expect(SignedGrantSchema.safeParse(grant).success).toBe(true)
    expect(SignedGrantSchema.safeParse({
      ...grant,
      capabilities: [{
        capabilityId: 'CAP-BROWSER-SUBSTITUTE', nonce: 'b'.repeat(64),
        transport: 'browser-local', effect: 'read', actionId: 'ACTION-1',
        operation: 'dom-read', maxUses: 1,
      }],
    }).success).toBe(false)
    expect(SignedGrantSchema.safeParse({
      ...grant,
      capabilities: [
        grant.capabilities[0],
        { ...grant.capabilities[0], capabilityId: 'CAP-READ-HTTP-2', nonce: 'b'.repeat(64) },
      ],
    }).success).toBe(false)
    expect(SignedGrantSchema.safeParse({
      ...grant,
      capabilities: [{ ...grant.capabilities[0], maxUses: 100_000 }],
    }).success).toBe(false)
    expect(SignedGrantSchema.safeParse({
      ...grant,
      subject: { ...subject, requests: [{ ...readRequest, url: 'https://example.test/api/admin' }] },
    }).success).toBe(false)
    expect(SignedGrantSchema.safeParse({
      ...grant, capabilities: [{ ...grant.capabilities[0], requestIds: ['REQUEST-UNSIGNED'] }],
    }).success).toBe(false)
  })
})
