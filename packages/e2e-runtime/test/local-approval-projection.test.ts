import { describe, expect, test } from 'vitest'
import { digestArtifactContent, digestText } from '@mutil-skills/e2e-contracts'
import { projectLocalApproval } from '../src/local-approval-projection.js'

const digest = (char: string) => `sha256:${char.repeat(64)}`

describe('local approval projection', () => {
  test('projects a reversible write into a secret-free confirmation summary', () => {
    const projected = projectLocalApproval({
      snapshot: snapshot('test'), approvalType: 'execution', subjectDigest: digest('a'),
      grantSubject: {
        environment: 'test', baseOrigin: 'https://test.example.com', actions: [{
          actionId: 'ACTION-1', effect: 'reversible-write', maxUses: 1,
          dataLeaseId: 'LEASE-1', cleanupPlanDigest: digest('c'),
          requests: [{ method: 'POST', canonicalOrigin: 'https://test.example.com',
            body: { segments: [{ kind: 'secret-ref', secretRef: 'API_TOKEN' }] } }],
        }],
      } as never,
      expiresAt: '2026-07-19T00:10:00.000Z',
    })

    expect(projected.disposition.kind).toBe('confirmation-required')
    expect(projected.summary).toMatchObject({
      environmentId: 'test', riskTier: 'test', origins: ['https://test.example.com'],
      methods: ['POST'], effects: ['reversible-write'], secretRefs: ['API_TOKEN'],
      dataLeaseRefs: ['LEASE-1'], maxUses: 1,
      semanticReview: {
        prd: { normalizedText: '# 订单\n必须显示待审核订单。', sourceRef: 'inputs/prd.md' },
        requirements: [{ reqId: 'REQ-1', rules: [{ ruleId: 'RULE-1',
          oracleMapping: 'explicit', oracles: [{ oracleId: 'ORACLE-1' }] }] }],
      },
    })
    expect(JSON.stringify(projected.summary)).not.toContain('password')
  })

  test('missing risk tier is production and blocks local confirmation', () => {
    const projected = projectLocalApproval({
      snapshot: snapshot(undefined), approvalType: 'scope', subjectDigest: digest('a'),
      expiresAt: '2026-07-19T00:10:00.000Z',
    })
    expect(projected.summary.riskTier).toBe('production')
    expect(projected.disposition).toMatchObject({ kind: 'blocked' })
  })

  test('recognizes bounded WebSocket and SSE actions as read-only', () => {
    for (const action of [
      { actionId: 'ACTION-WS', origin: 'wss://test.example.com', path: '/events',
        maxInboundMessages: 1, maxBytes: 1024 },
      { actionId: 'ACTION-SSE', origin: 'https://test.example.com', exactPath: '/events',
        query: [], maxReconnects: 1, maxUses: 1 },
    ]) {
      const projected = projectLocalApproval({
        snapshot: snapshot('test'), approvalType: 'execution', subjectDigest: digest('b'),
        grantSubject: { environment: 'test', actions: [action] } as never,
        expiresAt: '2026-07-19T00:10:00.000Z',
      })
      expect(projected.summary.effects).toEqual(['read'])
      expect(projected.disposition.kind).toBe('confirmation-required')
    }
  })
})

function snapshot(riskTier: string | undefined) {
  const normalizedText = '# 订单\n必须显示待审核订单。'
  const requirementModel: Record<string, unknown> = {
    artifactId: 'ARTIFACT-REQUIREMENT-MODEL', artifactType: 'requirement-model', schemaVersion: '1.0.0',
    engineVersion: '0.3.0', assetId: 'ASSET-1', prdRevision: digest('1'), generationId: 'GEN-1',
    createdAt: '2026-07-19T00:00:00.000Z', contentDigest: '', signatures: [], dependencies: [],
    graph: { defines: [], references: [] }, content: { modelRevision: 1, requirements: [{
      reqId: 'REQ-1', revision: 1, title: '订单列表', actors: ['auditor'], entities: ['order'],
      preconditions: [], rules: [{ ruleId: 'RULE-1', category: 'business', statement: '显示待审核订单',
        sourceRefs: ['PRD-1'], certainty: 'explicit', oracleIds: ['ORACLE-1'] }], states: [], transitions: [],
      observableOutcomes: [{ oracleId: 'ORACLE-1', statement: '页面显示待审核订单' }], applicability: [],
      sourceRefs: ['PRD-1'], status: 'active',
    }], coupledDimensions: [], applicabilityRules: ['RULE-1'], modelDecisionDigest: digest('2') },
  }
  requirementModel.contentDigest = digestArtifactContent(
    'artifact-content/1.0.0/requirement-model', requirementModel,
  )
  return {
    runId: 'RUN-1', frozenArtifacts: {
      'project-policy': { content: { environments: [{
        environmentId: 'test', baseOrigin: 'https://test.example.com',
        ...(riskTier === undefined ? {} : { riskTier }),
      }] } },
      'requirement-model': requirementModel,
    },
    trustedExecutionFacts: { 'prd-source-snapshot': {
      schemaVersion: '1.0.0', sourceRef: 'inputs/prd.md', normalizedText,
      normalizedDigest: digestText('e2e-prd-normalized-source/v1', normalizedText),
      byteLength: Buffer.byteLength(normalizedText),
    } },
  } as never
}
