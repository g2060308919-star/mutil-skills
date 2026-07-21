import { describe, expect, test } from 'vitest'
import { digestApprovalProjection } from '../src/index.js'

describe('approval projection digest', () => {
  test('action-map 替换 capabilityId 保持稳定，但任一行为/安全字段变化都会改变摘要', () => {
    const content = {
      actionMapRevision: 1, pageIdentities: [{ pageId: 'PAGE-1', origin: 'https://example.test', assertionDigest: 'D' }],
      actions: [{ caseId: 'CASE-1', stepId: 'STEP-1', actionId: 'ACTION-1', pageIdentityId: 'PAGE-1',
        locatorCandidates: [{ strategy: 'role', value: 'main', confidence: 1 }], playwrightAction: 'page.goto',
        waits: [], oracleIds: ['ORACLE-1'], effect: 'read', requestIds: [],
        capabilities: [{ operation: 'dom-read', capabilityId: 'CAP-1' }] }],
      unmappedSteps: [], discoveredRisks: [],
    }
    const baseline = digestApprovalProjection('browser-action-map', content)
    expect(digestApprovalProjection('browser-action-map', structuredClone({ ...content,
      actions: [{ ...content.actions[0]!, capabilities: [{ operation: 'dom-read', capabilityId: 'CAP-2' }] }],
    }))).toBe(baseline)
    for (const mutate of [
      (value: any) => { value.actions[0].effect = 'unknown' },
      (value: any) => { value.actions[0].capabilities[0].operation = 'screenshot' },
      (value: any) => { value.actions[0].locatorCandidates[0].value = 'admin' },
      (value: any) => { value.pageIdentities[0].origin = 'https://evil.test' },
    ]) {
      const changed = structuredClone(content); mutate(changed)
      expect(digestApprovalProjection('browser-action-map', changed)).not.toBe(baseline)
    }
    expect(() => digestApprovalProjection('browser-action-map', { ...content, newSecurityField: true }))
      .toThrow('E2E_APPROVAL_PROJECTION_KEYS_INVALID')
  })

  test.each(['project-policy', 'acceptance-scope', 'requirement-model', 'coverage-universe', 'test-cases'] as const)(
    '%s 覆盖完整 content，任一字段变化都会改变摘要', (type) => {
      const content = { stable: true, nested: { value: 1 } }
      expect(digestApprovalProjection(type, { ...content, nested: { value: 2 } }))
        .not.toBe(digestApprovalProjection(type, content))
    },
  )

  test('run-bundle 投影覆盖执行计划与安全字段，只排除 Authority 输出的 capabilityId/digest', () => {
    const bundle = { runId: 'RUN-1', allInputRefs: [{ artifactId: 'A', digest: 'D' }],
      schedule: [{ ordinal: 0, caseId: 'CASE-1', stepIds: ['STEP-1'], actionIds: ['ACTION-1'] }],
      attemptPlans: [{ caseId: 'CASE-1', slots: 1 }],
      signedCapabilities: [{ capabilityId: 'CAP-1', actionId: 'ACTION-1', operation: 'dom-read',
        effect: 'read', maxUses: 1, digest: 'D1' }], secretRefs: ['SECRET-1'], runtimePolicyDigest: 'P1',
      runtimeIsolationPolicyDigest: 'not-applicable' }
    const baseline = digestApprovalProjection('run-bundle', bundle)
    const authorityOnly = structuredClone(bundle)
    authorityOnly.signedCapabilities[0]!.capabilityId = 'CAP-2'
    authorityOnly.signedCapabilities[0]!.digest = 'D2'
    expect(digestApprovalProjection('run-bundle', authorityOnly)).toBe(baseline)
    for (const mutate of [
      (value: any) => { value.attemptPlans[0].slots = 99 },
      (value: any) => { value.schedule[0].actionIds = ['ACTION-2'] },
      (value: any) => { value.secretRefs = ['SECRET-2'] },
      (value: any) => { value.runtimePolicyDigest = 'P2' },
      (value: any) => { value.runtimeIsolationPolicyDigest = 'P3' },
      (value: any) => { value.signedCapabilities[0].operation = 'screenshot' },
    ]) {
      const changed = structuredClone(bundle); mutate(changed)
      expect(digestApprovalProjection('run-bundle', changed)).not.toBe(baseline)
    }
  })
})
