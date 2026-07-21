import { describe, expect, test } from 'vitest'
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
      expect(projected.disposition.kind).toBe('auto-approved')
    }
  })
})

function snapshot(riskTier: string | undefined) {
  return {
    runId: 'RUN-1', frozenArtifacts: {
      'project-policy': { content: { environments: [{
        environmentId: 'test', baseOrigin: 'https://test.example.com',
        ...(riskTier === undefined ? {} : { riskTier }),
      }] } },
    },
  } as never
}
