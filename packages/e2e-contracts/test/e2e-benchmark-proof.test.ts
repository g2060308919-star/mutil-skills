import { describe, expect, test } from 'vitest'
import {
  BrowserCapabilityMatrixV1Schema,
  E2EBenchmarkProofV1Schema,
  computeBrowserCapabilityMatrixDigest,
  computeE2EBenchmarkProofDigest,
} from '../src/index.js'

const d = (value: string) => `sha256:${value.repeat(64)}`

describe('unified E2E benchmark proof contracts', () => {
  test('localhost Mock 只证明 browser-product，后端/数据库/IdP 保持 not-verified', () => {
    const body = {
      schemaVersion: 'e2e-benchmark-proof/v1' as const,
      proofKind: 'real-project' as const,
      proofId: 'PROOF-REAL-1', runnerIdentityDigest: d('1'), corpusDigest: d('2'),
      application: { applicationId: 'REAL-APP-1', stack: 'React-AntD', sourceRevision: d('3'),
        targetOrigin: 'http://127.0.0.1:3000', startupCommandDigest: d('4') },
      components: [
        { component: 'browser-product' as const, mode: 'real' as const, claim: 'verified' as const,
          reason: '真实 Chrome 加载产品 bundle 并通过 UI 完成交互' },
        { component: 'backend' as const, mode: 'substituted' as const, claim: 'not-verified' as const,
          reason: '由本地 Mock API 替代' },
        { component: 'database' as const, mode: 'substituted' as const, claim: 'not-verified' as const,
          reason: '由内存数据替代' },
        { component: 'idp' as const, mode: 'substituted' as const, claim: 'not-verified' as const,
          reason: '由测试角色选择器替代' },
      ],
      scenarios: [{ scenarioId: 'SCENARIO-1', status: 'passed' as const, oracleStatus: 'passed' as const,
        evidenceDigests: [d('5')], attemptIds: ['ATTEMPT-1'], negativeControlDetected: true }],
      gate: { eligible: true, passed: true, reasons: [] },
      generatedAt: '2026-08-12T00:00:00.000Z',
    }
    const proof = { ...body, proofDigest: computeE2EBenchmarkProofDigest(body) }
    expect(E2EBenchmarkProofV1Schema.parse(proof)).toEqual(proof)
  })

  test('预置最终 DOM、绕过被测登录或 Mock 被测鉴权时禁止 gateEligible', () => {
    const body = {
      schemaVersion: 'e2e-benchmark-proof/v1' as const,
      proofKind: 'full-product-journey' as const,
      proofId: 'PROOF-BAD-1', runnerIdentityDigest: d('1'), corpusDigest: d('2'),
      application: { applicationId: 'APP-1', stack: 'React', sourceRevision: d('3'),
        targetOrigin: 'http://localhost:3000', startupCommandDigest: d('4') },
      components: [{ component: 'browser-product' as const, mode: 'substituted' as const,
        claim: 'verified' as const, reason: '预置最终 DOM' }],
      scenarios: [{ scenarioId: 'S-1', status: 'passed' as const, oracleStatus: 'passed' as const,
        evidenceDigests: [d('5')], attemptIds: ['A-1'], negativeControlDetected: false }],
      gate: { eligible: true, passed: true, reasons: [] },
      generatedAt: '2026-08-12T00:00:00.000Z',
    }
    expect(E2EBenchmarkProofV1Schema.safeParse({ ...body,
      proofDigest: computeE2EBenchmarkProofDigest(body) }).success).toBe(false)
  })

  test('Capability Matrix 的 supported 必须绑定组件 proof 与真实项目 proof', () => {
    const body = { schemaVersion: 'browser-capability-matrix/v1' as const, matrixVersion: '1.0.0',
      runnerIdentityDigest: d('1'), entries: [{ capabilityId: 'CAP-popup-identity', status: 'supported' as const,
        boundary: '受 Target/page identity 约束的 popup', compilerSemantics: 'popup pageScope + stable pageId',
        componentProofDigest: d('2'), realProjectProofDigest: d('3'), failureClassification: 'business-failure',
        timeoutCancellation: 'bounded-deadline', oracleEvidence: ['url', 'dom', 'trace'],
        cleanup: 'close-popup-and-context', retryRecovery: 'read-only-max-2', verifiedHosts: ['darwin-arm64'],
        verifiedChrome: ['stable'] }], generatedAt: '2026-08-12T00:00:00.000Z' }
    const matrix = { ...body, matrixDigest: computeBrowserCapabilityMatrixDigest(body) }
    expect(BrowserCapabilityMatrixV1Schema.parse(matrix)).toEqual(matrix)
    const unsupported = structuredClone(body)
    delete (unsupported.entries[0] as Partial<typeof unsupported.entries[number]>).realProjectProofDigest
    expect(BrowserCapabilityMatrixV1Schema.safeParse({ ...unsupported,
      matrixDigest: computeBrowserCapabilityMatrixDigest(unsupported as typeof body) }).success).toBe(false)
  })
})
