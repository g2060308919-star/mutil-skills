import { describe, expect, test } from 'vitest'
import { E2EError } from '@mutil-skills/e2e-contracts'
import { createTrustedCompilerReadiness } from '@mutil-skills/e2e-engine'
import { projectCompilerInputFromArtifacts } from '../src/index.js'
import { inspectTrustedCompilerInput } from '../src/compiler-input-projector.js'
import { approvedCompilerArtifacts, approvedFullPlaywrightCompilerArtifacts,
  compilerArtifactVerification, FULL_PLAYWRIGHT_CLEANUP_SOURCE,
  FULL_PLAYWRIGHT_SOURCE } from './compiler-artifacts.fixture.js'

describe('Artifact → Compiler Input Projector', () => {
  test('Engine readiness 缺少真实 PRD、scope、lineage Artifact 时 fail closed', () => {
    expect(() => createTrustedCompilerReadiness({
      artifacts: [], contractsVersion: '2.0.0', verifyArtifactSignature: () => true,
      verifyDecisionReceipt: () => true,
    })).toThrow('E2E_COMPILER_READINESS_ARTIFACT_SET_INVALID')
  })

  test('业务请求不能用普通对象伪造 Host 启动期信任根', () => {
    expect(() => projectCompilerInputFromArtifacts({
      artifacts: approvedCompilerArtifacts(), nodeVersion: '24.18.0', playwrightVersion: '1.61.1', trust: {} as never,
    })).toThrow('E2E_COMPILER_TRUST_INVALID')
  })

  test('从同代已验证 Artifact 投影封闭只读 Compiler Input，不复制 playwrightAction', () => {
    const trusted = projectCompilerInputFromArtifacts({
      artifacts: approvedCompilerArtifacts(), playwrightVersion: '1.61.1', ...compilerArtifactVerification,
    })
    const input = inspectTrustedCompilerInput(trusted)
    expect(input).toMatchObject({
      schemaVersion: 'compiler-input/v1', assetId: 'PRODUCT/PRD-1', generationId: 'GEN-1',
      environmentId: 'TEST', cases: [{ caseId: 'CASE-READ-1', reqIds: ['REQ-1'], actions: [{
        kind: 'assertText', actionId: 'ACTION-READ-1', target: '订单状态', expected: '待审核',
      }] }],
    })
    expect(JSON.stringify(input)).not.toContain('playwrightAction')
    expect(JSON.stringify(input)).not.toContain('page.goto')
  })

  test('从可逆写 Artifact 投影语义 Bridge Action，不复制 click 源码', () => {
    const input = inspectTrustedCompilerInput(projectCompilerInputFromArtifacts({
      artifacts: approvedCompilerArtifacts({ effect: 'reversible-write' }), playwrightVersion: '1.61.1',
      ...compilerArtifactVerification,
    }))
    expect(input.cases[0]?.actions[0]).toEqual({
      kind: 'reversibleWrite', actionId: 'ACTION-WRITE-1', buttonName: '批准订单',
      beforeText: '待审核', afterText: '已批准', dataLeaseId: 'LEASE-1', cleanupPlanId: 'CLEANUP-1',
    })
    expect(JSON.stringify(input)).not.toContain('.click')
  })

  test('从同一冻结 Action Map 与 Execution Contract 唯一投影 full Playwright action', () => {
    const input = inspectTrustedCompilerInput(projectCompilerInputFromArtifacts({
      artifacts: approvedFullPlaywrightCompilerArtifacts(), playwrightVersion: '1.61.1',
      ...compilerArtifactVerification,
    }))
    expect(input.executionProfile).toBe('full-playwright')
    expect(input.cases[0]?.actions).toEqual([{
      kind: 'fullPlaywright', actionId: 'ACTION-WRITE-1', source: FULL_PLAYWRIGHT_SOURCE,
      sourceDigest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
      cleanupSource: FULL_PLAYWRIGHT_CLEANUP_SOURCE,
      cleanupSourceDigest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
      dataLeaseId: 'LEASE-1', cleanupPlanId: 'CLEANUP-1', timeoutMs: 30_000, cleanupTimeoutMs: 30_000,
    }])
  })

  test.each([
    ['program source', { executionSource: "await page.goto('https://drift.example')" }],
    ['capability set', { runBundleCapabilityId: 'CAP-FULL-DRIFT' }],
    ['request set', { approvalRequestPath: '/different' }],
  ])('拒绝 full Playwright %s 在冻结资产之间漂移', (_name, drift) => {
    expect(() => projectCompilerInputFromArtifacts({
      artifacts: approvedFullPlaywrightCompilerArtifacts(drift), playwrightVersion: '1.61.1',
      ...compilerArtifactVerification,
    })).toThrow(/E2E_COMPILER_(?:INPUT_INVALID|APPROVAL_BINDING_INVALID)/)
  })

  test('拒绝未绑定 source 的 full Playwright digest', () => {
    expect(() => projectCompilerInputFromArtifacts({
      artifacts: approvedFullPlaywrightCompilerArtifacts({ sourceDigest: `sha256:${'0'.repeat(64)}` }),
      playwrightVersion: '1.61.1', ...compilerArtifactVerification,
    })).toThrow(/E2E_(?:COMPILER_(?:INPUT_INVALID|CODE_FIELD_REJECTED)|APPROVAL_PROJECTION_FULL_PLAYWRIGHT_PROGRAM_INVALID)/)
  })

  test('拒绝 active step 集之外但在 mapping/program/intent/cleanup/capability/approval 中自洽的 leftover Action', () => {
    expect(() => projectCompilerInputFromArtifacts({
      artifacts: approvedFullPlaywrightCompilerArtifacts({ extraFullAction: true }),
      playwrightVersion: '1.61.1', ...compilerArtifactVerification,
    })).toThrow(/E2E_COMPILER_(?:INPUT_INVALID|APPROVAL_BINDING_INVALID)/)
  })

  test('拒绝不同 generation、额外 Artifact 类型和调用方代码字段', () => {
    const mixed = approvedCompilerArtifacts()
    mixed[1] = { ...(mixed[1] as Record<string, unknown>), generationId: 'GEN-OTHER' }
    expect(() => projectCompilerInputFromArtifacts({ artifacts: mixed, playwrightVersion: '1.61.1', ...compilerArtifactVerification }))
      .toThrow(/E2E_COMPILER_INPUT_INVALID|E2E_COMPILER_ARTIFACT_NOT_VERIFIED/)
    expect(() => projectCompilerInputFromArtifacts({ artifacts: [...approvedCompilerArtifacts(), {
      artifactType: 'playwright-source', sourceFiles: [{ bytes: 'process.env.HOME' }],
    }], playwrightVersion: '1.61.1', ...compilerArtifactVerification })).toThrow(/E2E_COMPILER_CODE_FIELD_REJECTED|E2E_COMPILER_INPUT_INVALID/)
    try {
      projectCompilerInputFromArtifacts({ artifacts: mixed, playwrightVersion: '1.61.1', ...compilerArtifactVerification })
    } catch (error) {
      expect(error).toBeInstanceOf(E2EError)
    }
  })

  test('拒绝 contentDigest 未绑定实际内容的伪造 Artifact', () => {
    const forged = approvedCompilerArtifacts()
    const policy = forged.find((artifact) =>
      (artifact as { artifactType?: string }).artifactType === 'project-policy') as {
        content: { environments: Array<{ environmentId: string }> }
      }
    policy.content.environments[0]!.environmentId = 'FORGED'
    expect(() => projectCompilerInputFromArtifacts({ artifacts: forged, playwrightVersion: '1.61.1', ...compilerArtifactVerification }))
      .toThrow(/E2E_COMPILER_ARTIFACT_NOT_VERIFIED/)
  })

  test('即使 Artifact 外层签名有效，也拒绝与审批 subject 不闭合的投影', () => {
    expect(() => projectCompilerInputFromArtifacts({
      artifacts: approvedCompilerArtifacts({ mismatchedApprovalProjection: true }),
      playwrightVersion: '1.61.1', ...compilerArtifactVerification,
    })).toThrow(/E2E_COMPILER_APPROVAL_BINDING_INVALID/)
  })
})
