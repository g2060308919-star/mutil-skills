import { describe, expect, test } from 'vitest'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import {
  ArtifactSchemaRegistry,
  WriteApprovalSubjectV2Schema,
  digestCleanupPlanDefinition,
  digestText,
} from '@mutil-skills/e2e-contracts'
import { runtimeTodoMvcFullPlaywrightFixture } from './e2e-runtime-read-only.fixture.js'
import { auditTrustedRegressionSourceSet } from '../packages/e2e-playwright-runtime/src/trusted-source-audit.js'
import { auditSemanticCompleteness } from '../packages/e2e-engine/src/semantic-completeness.js'

describe('TodoMVC full Playwright 公开目标 fixture', () => {
  test('本地 PRD Golden 与官方固定提交的 Git blob 完全一致', async () => {
    const bytes = await readFile(new URL('./e2e-todomvc-app-spec.fixture.md', import.meta.url))
    const blob = createHash('sha1').update(`blob ${bytes.byteLength}\0`).update(bytes).digest('hex')

    expect(bytes.byteLength).toBe(6509)
    expect(blob).toBe('d040877fd8895c4f18fa5190e4b8ee474ffa8ac4')
  })

  test('提供独立的 TodoMVC PRD 到 full-playwright 资产构建入口', async () => {
    const fixtureModule = await import('./e2e-runtime-read-only.fixture.js') as Record<string, unknown>

    expect(fixtureModule.runtimeTodoMvcFullPlaywrightFixture).toBeTypeOf('function')
  })

  test('冻结 TodoMVC 专用 Case、Action、静态资源和清理终态', () => {
    const fixture = runtimeTodoMvcFullPlaywrightFixture({
      runId: 'RUN-TODOMVC-FULL-1', assetId: 'ASSET-TODOMVC-FULL-1',
      prdRevision: `sha256:${'1'.repeat(64)}`, installationDigest: `sha256:${'2'.repeat(64)}`,
      url: 'https://todomvc.com/examples/typescript-react/', now: new Date('2026-07-26T00:00:00.000Z'),
    })
    const execution = fixture.frozenArtifacts['execution-contract'].content as any
    const program = execution.fullPlaywrightPrograms[0]

    expect(fixture.expected).toMatchObject({
      caseId: 'CASE-TODOMVC-FUNCTIONAL-1',
      actionId: 'ACTION-TODOMVC-FUNCTIONAL-1',
      cleanupState: 'empty',
    })
    expect(execution.baseOrigin).toBe('https://todomvc.com')
    expect(execution.identities).toEqual([{
      identityId: 'IDENTITY-VISITOR', roleIds: ['visitor'], secretRef: 'SECRET-REF-LOCAL',
    }])
    expect(program.networkRequests.map((request: any) => request.exactPath)).toEqual([
      '/examples/typescript-react/',
      '/examples/typescript-react/node_modules/todomvc-common/base.css',
      '/examples/typescript-react/node_modules/todomvc-app-css/index.css',
      '/examples/typescript-react/node_modules/director/build/director.js',
      '/examples/typescript-react/js/bundle.js',
    ])
    expect(program.networkRequestBodies).toEqual([])
    expect(program.networkRequests.every((request: any) => request.maxRequests === 6)).toBe(true)
    expect(program.networkRequests.map((request: any) => request.expectedOrder)).toEqual([1, 2, 2, 2, 2])
    const manifest = fixture.semanticArtifacts['prd-manifest'].content as any
    const scope = fixture.semanticArtifacts['acceptance-scope'].content as any
    const model = fixture.semanticArtifacts['requirement-model'].content as any
    const coverage = fixture.semanticArtifacts['coverage-universe'].content as any
    expect(manifest.clauses).toHaveLength(35)
    expect(scope.clauseDispositions).toHaveLength(35)
    expect(model.requirements).toHaveLength(25)
    expect(model.requirements.every((requirement: any) => requirement.rules.length === 1
      && requirement.observableOutcomes.length === 1)).toBe(true)
    expect(coverage.obligations).toHaveLength(25)
    expect(program.oracleCheckpoints).toHaveLength(25)
    expect(program.oracleCheckpoints.find((checkpoint: any) => checkpoint.oracleId === 'ORACLE-TODOMVC-F20'))
      .toMatchObject({ expectedJson: '"todos-react"' })
  })

  test('生成的 program 与 cleanup 通过 full-playwright AST 安全审计', () => {
    const fixture = runtimeTodoMvcFullPlaywrightFixture({
      runId: 'RUN-TODOMVC-AUDIT', assetId: 'ASSET-TODOMVC-AUDIT',
      prdRevision: `sha256:${'3'.repeat(64)}`, installationDigest: `sha256:${'4'.repeat(64)}`,
      url: 'https://todomvc.com/examples/typescript-react/', now: new Date('2026-07-26T00:00:00.000Z'),
    })
    const execution = fixture.frozenArtifacts['execution-contract'].content as any
    const program = execution.fullPlaywrightPrograms[0]
    const wrap = (source: string, kind: 'Run' | 'Cleanup') => Buffer.from([
      "import { test, expect } from '@playwright/test'",
      "test('trusted fragment', async ({ page, context, browser, request }, testInfo) => {",
      '  const state = {} as Record<string, unknown>',
      '  const checkpoint = async (_input: { checkpointId: string; oracleId: string; actual: unknown }) => undefined',
      `  const __biztest${kind}0 = async () => {`,
      source, '  }', `  await __biztest${kind}0()`, '})', '',
    ].join('\n'))

    expect(auditTrustedRegressionSourceSet([
      { relativePath: 'regression/fragments/todomvc-source.ts', bytes: wrap(program.source, 'Run') },
      { relativePath: 'regression/fragments/todomvc-cleanup.ts', bytes: wrap(program.cleanupSource, 'Cleanup') },
    ], 'full-playwright').findings).toEqual([])
  })

  test('语义、Case、Action、Cleanup、审批主题和回归清单形成同一条可追踪链', () => {
    const fixture = runtimeTodoMvcFullPlaywrightFixture({
      runId: 'RUN-TODOMVC-TRACE', assetId: 'ASSET-TODOMVC-TRACE',
      prdRevision: digestText('test/v1', 'todomvc-prd'),
      installationDigest: digestText('test/v1', 'runtime'),
      url: 'https://todomvc.com/examples/typescript-react/', now: new Date('2026-07-26T00:00:00.000Z'),
    })
    for (const document of [
      ...Object.values(fixture.semanticArtifacts), ...Object.values(fixture.frozenArtifacts),
      fixture.regressionManifest,
    ]) {
      const parsed = ArtifactSchemaRegistry[document.artifactType].safeParse(document)
      expect(parsed.success, `${document.artifactType}:${parsed.success ? '' : parsed.error.message}`).toBe(true)
    }
    const execution = fixture.frozenArtifacts['execution-contract'].content as any
    const actionMap = fixture.frozenArtifacts['browser-action-map'].content as any
    const testCases = fixture.frozenArtifacts['test-cases'].content as any
    const coverage = fixture.semanticArtifacts['coverage-universe'].content as any
    const program = execution.fullPlaywrightPrograms[0]
    const cleanupPlan = execution.writeCleanupPlans[0]
    const subject = WriteApprovalSubjectV2Schema.parse(fixture.writeSubject(
      'DISCOVERY-TODOMVC-1', digestText('test/v1', 'preflight'),
    ))
    const discovery = fixture.discoverySubject()

    expect(auditSemanticCompleteness({
      manifest: fixture.semanticArtifacts['prd-manifest'].content as Record<string, unknown>,
      scope: fixture.semanticArtifacts['acceptance-scope'].content as Record<string, unknown>,
      model: fixture.semanticArtifacts['requirement-model'].content as Record<string, unknown>,
      flows: fixture.semanticArtifacts['interaction-flow'].content as Record<string, unknown>,
      coverage, cases: testCases,
    })).toMatchObject({ findings: [], coverageFacts: {
      prdClauses: { covered: 35, total: 35 }, requirementDesign: { covered: 25, total: 25 },
      rules: { covered: 25, total: 25 }, oracles: { covered: 25, total: 25 },
      cases: { covered: 1, total: 1 },
    } })

    expect(testCases.cases.map((item: any) => item.caseId)).toEqual([program.caseId])
    expect(coverage.obligations[0].disposition.caseIds).toEqual([program.caseId])
    expect(execution.caseQueue.map((item: any) => item.caseId)).toEqual([program.caseId])
    expect(actionMap.actions[0]).toMatchObject({
      caseId: program.caseId, stepId: program.stepId, actionId: program.actionId,
    })
    expect(actionMap.fullPlaywrightPrograms[0]).toEqual(program)
    expect(cleanupPlan).toMatchObject({
      cleanupPlanId: 'CLEANUP-TODOMVC-1', leaseId: 'LEASE-TODOMVC-1',
      actionId: program.actionId, cleanupProgramDigest: program.cleanupSourceDigest,
      cleanupRequestIntentIds: [],
    })
    expect(subject.actions[0]).toMatchObject({
      actionId: program.actionId, programDigest: program.sourceDigest,
      cleanupProgramDigest: program.cleanupSourceDigest,
      cleanupPlanDigest: digestCleanupPlanDefinition(cleanupPlan),
      requests: program.networkRequests,
    })
    expect(discovery.requests.map((request: any) => new URL(request.url).pathname)).toEqual(
      program.networkRequests.map((request: any) => request.exactPath),
    )
    expect(discovery.actions).toEqual(expect.arrayContaining([
      expect.objectContaining({ operation: 'local-navigation', requestIds: [] }),
      expect.objectContaining({ operation: 'http-request',
        requestIds: discovery.requests.map((request: any) => request.requestId) }),
    ]))
    expect((fixture.regressionManifest.content as any).caseMappings[0].caseId).toBe(program.caseId)
  })
})
