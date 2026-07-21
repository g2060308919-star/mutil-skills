import { describe, expect, test } from 'vitest'
import {
  ARTIFACT_TYPES,
  ArtifactSchemaRegistry,
  ReportGatewayAuditSchema,
  RuntimeProvenanceSchema,
  parseArtifactDocument,
} from '../src/index.js'

const expectedTypes = [
  'project-policy', 'prd-request', 'prd-manifest', 'prd-diff', 'semantic-generation',
  'acceptance-scope', 'requirement-model', 'interaction-flow', 'coverage-universe', 'test-cases',
  'design-audit', 'execution-contract', 'approval-grants', 'manual-results', 'data-leases',
  'browser-preflight', 'browser-action-map', 'regression-manifest', 'run-bundle', 'workflow-events',
  'browser-results', 'gateway-audit', 'browser-evidence', 'diagnosis', 'cleanup-results',
  'final-report', 'generation-manifest',
]

const digest = (character: string) => `sha256:${character.repeat(64)}`

function envelope(artifactType: string) {
  return {
    artifactId: `ARTIFACT-${artifactType.toUpperCase()}`,
    artifactType,
    schemaVersion: '1.0.0', engineVersion: '1.0.0', assetId: 'ASSET-1',
    prdRevision: digest('a'), generationId: 'GEN-1', createdAt: '2026-07-11T10:00:00.000Z',
    contentDigest: digest('b'), signatures: [], dependencies: [], graph: { defines: [], references: [] },
  }
}

describe('Artifact Schema registry', () => {
  test('contains exactly the 27 fixed artifact types and one strict schema for each type', () => {
    expect(ARTIFACT_TYPES).toEqual(expectedTypes)
    expect(Object.keys(ArtifactSchemaRegistry).sort()).toEqual([...expectedTypes].sort())
  })

  test('parses a strict project-policy document and rejects unknown type or content fields', () => {
    const document = {
      ...envelope('project-policy'), schemaVersion: '2.0.0',
      content: {
        policyVersion: '1.0.0',
        environments: [{ environmentId: 'test', baseOrigin: 'https://test.example.com' }],
        originPolicies: [{ origin: 'https://test.example.com', allowRead: true, allowWrite: false }],
        browserMatrix: [{ browserId: 'chrome', channel: 'chrome', required: true }],
        coveragePolicy: { id: 'coverage-v1', digest: digest('c') },
        evidencePolicy: { id: 'evidence-v1', digest: digest('d') },
        retentionPolicy: { id: 'retention-v1', digest: digest('e') },
        riskPolicy: { id: 'risk-v1', digest: digest('f') },
        timeoutPolicy: { id: 'timeout-v1', digest: digest('0') },
        runtimePolicy: { id: 'runtime-v1', digest: digest('1') },
      },
    }
    expect(parseArtifactDocument(document)).toEqual(document)
    expect(() => parseArtifactDocument({
      ...document, content: { ...document.content, unexpected: true },
    })).toThrow()
    expect(() => parseArtifactDocument({ ...document, artifactType: 'unknown-artifact' })).toThrow()
    expect(() => parseArtifactDocument({
      ...document,
      dependencies: [{
        artifactId: 'ARTIFACT-X', artifactType: 'prd-request', schemaVersion: '1.0.0',
        relativePath: '../outside.json', digest: digest('1'),
      }],
    })).toThrow()
    for (const relativePath of ['./x.json', 'a//b.json', 'a/', 'C:/x.json', 'x:stream', 'CON', 'a/com1.log']) {
      expect(() => parseArtifactDocument({
        ...document,
        dependencies: [{
          artifactId: 'ARTIFACT-X', artifactType: 'prd-request', schemaVersion: '1.0.0',
          relativePath, digest: digest('1'),
        }],
      }), relativePath).toThrow()
    }
  })

  test('报告 Gateway 状态能忠实表达 incomplete，而不是伪装成 invalid', () => {
    expect(ReportGatewayAuditSchema.safeParse({
      status: 'incomplete', digest: digest('1'), forwarded: 0, blocked: 0, injected: 0, findings: [],
    }).success).toBe(true)
  })

  test('cleanup-results v2 只接受独立清理事实，拒绝把旧 released 生命周期冒充 verified-clean', () => {
    const valid = {
      ...envelope('cleanup-results'), schemaVersion: '2.0.0',
      content: { leaseResults: [{ leaseId: 'LEASE-1', status: 'verified-clean', digest: digest('2') }] },
    }
    expect(() => parseArtifactDocument(valid)).not.toThrow()
    expect(() => parseArtifactDocument({
      ...valid, schemaVersion: '1.0.0',
      content: { leaseResults: [{ leaseId: 'LEASE-1', status: 'released', digest: digest('2') }] },
    })).toThrow()
  })

  test('Runtime provenance 是严格事实，且 final-report v3 / generation-manifest v2 拒绝旧版', () => {
    const provenance = {
      runtimeVersion: '0.1.0', runtimeInstallationDigest: digest('1'), protocolVersion: '1.0.0',
      contractsVersion: '0.1.0', engineVersion: '0.1.0', playwrightVersion: '1.61.1',
      chromiumDigest: digest('2'), gatewayPolicyDigest: digest('3'), authorityPublicKeyDigest: digest('4'),
      authorityStateProtectionLevel: 'local-crash-integrity',
      projectIdentityDigest: digest('5'), sourceRevisionDigest: digest('6'), sourceRepositoryIndependent: true,
      isolationProofDigest: digest('7'),
    }
    expect(RuntimeProvenanceSchema.parse(provenance)).toEqual(provenance)
    expect(RuntimeProvenanceSchema.safeParse({ ...provenance, sourceRepositoryIndependent: false }).success).toBe(false)
    expect(RuntimeProvenanceSchema.safeParse({ ...provenance, projectRoot: '/private/project' }).success).toBe(false)

    for (const [artifactType, schemaVersion] of [
      ['final-report', '2.0.0'], ['generation-manifest', '1.0.0'],
    ] as const) {
      expect(() => parseArtifactDocument({ ...envelope(artifactType), schemaVersion, content: {} }))
        .toThrowError(expect.objectContaining({ code: 'E2E_ARTIFACT_SCHEMA_MIGRATION_REQUIRED' }))
    }
  })
})
