import { describe, expect, test } from 'vitest'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { ARTIFACT_TYPES, generateArtifactJsonSchemas } from '../src/index.js'

describe('资产 JSON Schema 生成器', () => {
  test('为固定的 27 类资产生成可独立发布的严格 Schema', () => {
    const schemas = generateArtifactJsonSchemas()

    expect(Object.keys(schemas).sort()).toEqual([...ARTIFACT_TYPES].sort())
    for (const artifactType of ARTIFACT_TYPES) {
      const schema = schemas[artifactType] as Record<string, unknown>
      expect(schema.$schema).toBe('http://json-schema.org/draft-07/schema#')
      expect(schema.$id).toBe(`https://mutil-skills.local/e2e/schemas/${artifactType}.schema.json`)
      expect(schema.title).toBe(`${artifactType} artifact`)
      expect(schema.type).toBe('object')
      expect(schema.additionalProperties).toBe(false)
      expect(schema['x-e2e-runtime-validation']).toMatchObject({ required: true })
      expect(schema.required).toEqual(expect.arrayContaining([
        'artifactId', 'artifactType', 'assetId', 'prdRevision', 'generationId',
        'contentDigest', 'dependencies', 'graph', 'content',
      ]))
    }
  })

  test('同一输入每次生成完全相同的 Schema', () => {
    expect(generateArtifactJsonSchemas()).toEqual(generateArtifactJsonSchemas())
  })

  test('磁盘 current Schema 集与当前运行时生成结果逐文件一致', async () => {
    const root = new URL('../schemas/', import.meta.url)
    const pointer = JSON.parse(await readFile(new URL('current.json', root), 'utf8'))
    const manifest = JSON.parse(await readFile(new URL(pointer.relativePath, root), 'utf8'))
    const generated = generateArtifactJsonSchemas()

    expect(manifest.artifactTypes).toEqual(ARTIFACT_TYPES)
    for (const record of manifest.schemas) {
      const artifactType = record.file.replace(/\.schema\.json$/, '') as keyof typeof generated
      const expected = `${JSON.stringify(generated[artifactType], null, 2)}\n`
      const actual = await readFile(new URL(`sets/${pointer.setDigest.slice('sha256:'.length)}/${record.file}`, root), 'utf8')
      expect(actual, record.file).toBe(expected)
      expect(record.digest).toBe(`sha256:${createHash('sha256').update(actual).digest('hex')}`)
    }
  })

  test('外部 JSON Schema 也拒绝 dot segment、ADS 和非规范路径', () => {
    const schema = generateArtifactJsonSchemas()['project-policy'] as any
    const pattern = new RegExp(schema.properties.dependencies.items.properties.relativePath.pattern)
    expect(pattern.test('artifacts/source.json')).toBe(true)
    for (const path of ['../source.json', './source.json', 'a/../source.json', 'a//b', 'a/', 'C:/x', 'x:stream', 'NUL', 'a/Com1.txt']) {
      expect(pattern.test(path), path).toBe(false)
    }
  })

  test('每类 payload 完整覆盖 Spec 38.2 的必填字段', () => {
    const required: Record<string, string[]> = {
      'project-policy': ['policyVersion', 'environments', 'originPolicies', 'browserMatrix', 'coveragePolicy', 'evidencePolicy', 'retentionPolicy', 'riskPolicy', 'timeoutPolicy', 'runtimePolicy'],
      'prd-request': ['productSpace', 'title', 'sourceDescriptors', 'userRequest', 'testWorkspaceId', 'secretRefs'],
      'prd-manifest': ['prdId', 'assetId', 'revision', 'normalizedPrdDigest', 'sources', 'attachments', 'sourceCacheIndexDigest'],
      'prd-diff': ['previousRevision', 'currentRevision', 'sectionChanges', 'lineageMappings', 'lineageReview', 'impactedEntityIds'],
      'semantic-generation': ['modelProvider', 'modelId', 'modelVersion', 'systemPromptDigest', 'toolOutputDigests', 'sampling', 'candidateDigests', 'selectedDigest'],
      'acceptance-scope': ['includedReqCandidates', 'exclusions', 'ambiguities', 'dependencies', 'visualScope', 'browserScope', 'scopeDecision'],
      'requirement-model': ['modelRevision', 'requirements', 'coupledDimensions', 'applicabilityRules', 'modelDecisionDigest'],
      'interaction-flow': ['flows'],
      'coverage-universe': ['coveragePolicyDigest', 'pairwiseSeed', 'obligations', 'universeDigest'],
      'test-cases': ['cases', 'caseSetDigest'],
      'design-audit': ['inputDigests', 'metrics', 'findings', 'orphanIds', 'weakIds', 'status'],
      'execution-contract': ['environment', 'baseOrigin', 'browserMatrix', 'identities', 'caseQueue', 'actionIntents', 'dataNeeds', 'manualProcedures', 'evidencePolicyDigest', 'runtimeIsolation', 'unresolvedItems', 'readHttpRequests'],
      'approval-grants': ['runBundleDigest', 'grants'],
      'manual-results': ['results'],
      'data-leases': ['leases', 'allocatorEpoch'],
      'browser-preflight': ['checks', 'observedIdentity', 'actorChecks', 'leaseChecks', 'gatewayChecks', 'sandboxChecks', 'status'],
      'browser-action-map': ['actionMapRevision', 'pageIdentities', 'actions', 'unmappedSteps', 'discoveredRisks'],
      'regression-manifest': ['templateDigest', 'toolchain', 'sourceFiles', 'caseMappings', 'blockedCases', 'deprecatedCases', 'listResult'],
      'run-bundle': ['runId', 'allInputRefs', 'schedule', 'attemptPlans', 'signedCapabilities', 'secretRefs', 'runtimePolicyDigest', 'runtimeIsolationPolicyDigest'],
      'workflow-events': ['runId', 'attemptCases', 'workflowDigest'],
      'browser-results': ['runId', 'executedBrowserIds', 'caseResults', 'startedAt', 'finishedAt'],
      'gateway-audit': ['gatewayInstance', 'policyDigest', 'signedCounters', 'requestEvents', 'capabilityReservations'],
      'browser-evidence': ['evidencePolicyDigest', 'artifacts', 'caseCoverage', 'sanitizerProofs', 'privacyReviews'],
      diagnosis: ['caseDiagnoses', 'healingAttempts', 'selectedAttemptExplanations'],
      'cleanup-results': ['leaseResults'],
      'final-report': ['verdictRuleVersion', 'verdictInputDigest', 'verdict', 'reasonCodes', 'cannotClaim', 'metrics', 'scope', 'traceability', 'realResults', 'injectionResults', 'manualResults', 'risks', 'regression'],
      'generation-manifest': ['generationId', 'fencingToken', 'finalizationSnapshotDigest', 'artifacts', 'files', 'rootDigest', 'terminalVerdict', 'authoritySignature'],
    }
    const schemas = generateArtifactJsonSchemas()
    for (const artifactType of ARTIFACT_TYPES) {
      const content = (schemas[artifactType] as any).properties.content
      expect(content.required, artifactType).toEqual(expect.arrayContaining(required[artifactType]))
    }
  })

  test('Generation Manifest 将可表达的 26 类型闭包下推到 Draft-07，并声明运行时约束', () => {
    const schema = generateArtifactJsonSchemas()['generation-manifest'] as any
    expect(schema.properties.content.allOf).toHaveLength(26)
    expect(schema.properties.content.properties.artifacts.uniqueItems).toBe(true)
    expect(schema.properties.content.properties.files.uniqueItems).toBe(true)
    expect(schema['x-e2e-runtime-validation'].constraints).toEqual(expect.arrayContaining([
      expect.stringContaining('artifactId'), expect.stringContaining('rootDigest'),
    ]))
  })

  test('只读 HTTP 协议把可表达约束下推到 JSON Schema，并完整声明运行时 refinement', () => {
    const schemas = generateArtifactJsonSchemas() as any
    const execution = schemas['execution-contract']
    const requests = execution.properties.content.properties.readHttpRequests
    const request = requests.items
    const header = request.properties.headers.items
    const redirect = request.properties.redirectPolicy.anyOf.find(
      (candidate: any) => candidate.properties.mode.const === 'follow-approved',
    )
    const actionMapRequestIds = schemas['browser-action-map'].properties.content
      .properties.actions.items.properties.requestIds

    expect(requests.uniqueItems).toBe(true)
    expect(request.properties.url).toMatchObject({ format: 'uri', pattern: '^https?://' })
    expect(request.properties.headers.uniqueItems).toBe(true)
    expect(header.properties.name.not).toBeDefined()
    expect(header.properties.value).toMatchObject({ maxLength: 8192 })
    expect(redirect.properties.requestIds.uniqueItems).toBe(true)
    expect(actionMapRequestIds.uniqueItems).toBe(true)
    for (const artifactType of ['execution-contract', 'browser-action-map', 'approval-grants']) {
      expect(schemas[artifactType]['x-e2e-runtime-validation'].constraints).toEqual(expect.arrayContaining([
        expect.stringContaining('ReadHttpRequest'),
        expect.stringContaining('requestId'),
      ]))
    }
  })

  test('Approval capability 合法组合下推为 Draft-07 结构化 union', () => {
    const approval = generateArtifactJsonSchemas()['approval-grants'] as any
    const grantBranches = approval.properties.content.properties.grants.items.anyOf
    for (const grant of grantBranches) {
      const capability = grant.properties.capabilities.items
      expect(capability.anyOf).toHaveLength(3)
      const accepts = (candidate: Record<string, unknown>) => capability.anyOf
        .some((branch: any) => generatedObjectBranchAccepts(branch, candidate))
      const base = { capabilityId: 'CAP-1', actionId: 'ACTION-1', digest: `sha256:${'0'.repeat(64)}` }
      expect(accepts({ ...base, operation: 'dom-read', effect: 'read', maxUses: 2 })).toBe(true)
      expect(accepts({ ...base, operation: 'http-request', effect: 'reversible-write', maxUses: 1 })).toBe(true)
      expect(accepts({ ...base, operation: 'full-playwright', effect: 'reversible-write', maxUses: 1 })).toBe(true)
      expect(accepts({ ...base, operation: 'full-playwright', effect: 'read', maxUses: 1 })).toBe(false)
      expect(accepts({ ...base, operation: 'dom-read', effect: 'reversible-write', maxUses: 1 })).toBe(false)
      expect(accepts({ ...base, operation: 'http-request', effect: 'reversible-write', maxUses: 2 })).toBe(false)
    }
  })
})

function generatedObjectBranchAccepts(schema: any, candidate: Record<string, unknown>): boolean {
  if (schema.type !== 'object' || schema.additionalProperties !== false) return false
  if (schema.required.some((key: string) => !(key in candidate))) return false
  if (Object.keys(candidate).some((key) => !(key in schema.properties))) return false
  return Object.entries(candidate).every(([key, value]) => {
    const property = schema.properties[key]
    if (property.const !== undefined && property.const !== value) return false
    if (property.enum !== undefined && !property.enum.includes(value)) return false
    if (property.type === 'integer' && !Number.isInteger(value)) return false
    if (property.minimum !== undefined && (value as number) < property.minimum) return false
    if (property.exclusiveMinimum !== undefined && (value as number) <= property.exclusiveMinimum) return false
    if (property.maximum !== undefined && (value as number) > property.maximum) return false
    if (property.pattern !== undefined && !new RegExp(property.pattern).test(value as string)) return false
    return true
  })
}
