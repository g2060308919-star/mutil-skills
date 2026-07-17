import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { describe, expect, test } from 'vitest'
import { parseSkillManifest } from '../../schema/src/index.js'
import { listSkills, resolveSkill, resolveSkillDirectory } from '../src/index.js'

const workflowFiles = [
  'prd-intake.md',
  'scope-approval.md',
  'requirement-oracles.md',
  'coverage-universe.md',
  'execution-approval.md',
  'data-and-cleanup.md',
  'browser-preflight-binding.md',
  'safety-gateway.md',
  'browser-execution.md',
  'diagnosis-healing.md',
  'evidence-privacy.md',
  'regression-publication.md',
  'report-verdict.md',
  'artifact-transaction.md',
]

describe('E2E skill package', () => {
  test('registry exposes the E2E skill and its bundled workflow files', () => {
    const skill = resolveSkill('e2e')

    expect(skill?.id).toBe('e2e')
    expect(skill?.relativePath).toBe('skills/testing/e2e')
    expect(skill?.files.map((file) => file.name)).toEqual([
      'SKILL.md',
      'skill.manifest.json',
      ...workflowFiles,
    ])
    expect(existsSync(resolveSkillDirectory('e2e') ?? '')).toBe(true)
  })

  test('E2E manifest 只声明一个可安装 Runtime Host 能力门', async () => {
    const manifestText = await readFile(new URL('../skills/testing/e2e/skill.manifest.json', import.meta.url), 'utf8')
    const manifest = parseSkillManifest(JSON.parse(manifestText))

    expect(manifest).toMatchObject({
      id: 'e2e',
      name: 'PRD 驱动 E2E 浏览器验收',
      requires: [{
        capability: 'e2e.runtime-host',
        satisfiedBy: [
          '~/.mutil-skills/bin/repo-e2e doctor --json',
          'verified installation manifest + protocol major + safety probes',
        ],
        whenMissing: {
          action: 'prompt-install', package: '@mutil-skills/e2e-runtime', version: '0.1.0',
          terminalState: 'environment-blocked', reasonCode: 'E2E_RUNTIME_HOST_UNAVAILABLE',
        },
      }],
      source: {
        url: 'https://github.com/g2060308919-star/mutil-skills/blob/main/packages/skills/skills/testing/e2e/SKILL.md',
        rawUrl: 'https://raw.githubusercontent.com/g2060308919-star/mutil-skills/main/packages/skills/skills/testing/e2e/SKILL.md',
      },
    })
  })

  test.each(workflowFiles)('%s defines a standalone execution contract', async (file) => {
    const text = await readFile(new URL(`../skills/testing/e2e/${file}`, import.meta.url), 'utf8')

    for (const heading of [
      '## 适用状态',
      '## 必需 Artifact 与摘要',
      '## 允许的语义输出',
      '## 调用的确定性 API',
      '## 执行步骤',
      '## 退出条件',
      '## 暂停条件',
      '## 禁止行为',
      '## 独立调用',
    ]) {
      expect(text).toContain(heading)
    }
    expect(text).toContain('只返回最小缺失项')
    expect(text).toContain('不得重建上游')
  })

  test.each(['SKILL.md', ...workflowFiles])('%s 以中文为主要语言并统一使用固定 Runtime JSON 协议', async (file) => {
    const text = await readFile(new URL(`../skills/testing/e2e/${file}`, import.meta.url), 'utf8')
    const chineseCharacters = text.match(/\p{Script=Han}/gu)?.length ?? 0

    expect(chineseCharacters).toBeGreaterThanOrEqual(200)
    expect(text).toContain('~/.mutil-skills/bin/repo-e2e rpc')
    expect(text).toContain('JSON stdin/stdout')
    expect(text).toContain('RuntimeRequestEnvelope')
    expect(text).toContain('RuntimeResponseEnvelope')
    expect(text).toContain('verifiedDigests')
    expect(text).toContain('minimumMissingInput')
    expect(text).not.toMatch(/import\s+.*@mutil-skills\/e2e-/)
    expect(text).not.toMatch(/(?:npx|npm exec)[^\n]*e2e-(?:contracts|engine|authority|gateway|report|playwright)/)
  })

  test('入口 frontmatter description 使用中文开头', async () => {
    const text = await readFile(new URL('../skills/testing/e2e/SKILL.md', import.meta.url), 'utf8')

    expect(text).toMatch(/^---\nname: e2e\ndescription: [\p{Script=Han}]/u)
    expect(text).not.toContain('description: Use when')
  })

  test('入口使用严格成功投影并把恢复、报告渲染建模为真实 Runtime 命令', async () => {
    const text = await readFile(new URL('../skills/testing/e2e/SKILL.md', import.meta.url), 'utf8')

    for (const field of ['state', 'nextEdge', 'verifiedDigests', 'minimumMissingInput']) {
      expect(text).toContain(`\`${field}\``)
    }
    expect(text).toContain('`"command":"resume-run"`')
    expect(text).toContain('`"command":"render-report"`')
    expect(text).toContain('拒绝未知字段')
    expect(text).toContain('不得把 `approved: true` 当作审批')
  })

  test('恢复与报告子流程只能调用真实 Runtime 命令', async () => {
    const diagnosis = await readFile(new URL('../skills/testing/e2e/diagnosis-healing.md', import.meta.url), 'utf8')
    const transaction = await readFile(new URL('../skills/testing/e2e/artifact-transaction.md', import.meta.url), 'utf8')
    const report = await readFile(new URL('../skills/testing/e2e/report-verdict.md', import.meta.url), 'utf8')

    expect(diagnosis).toContain('`"command":"resume-run"`')
    expect(transaction).toContain('`"command":"resume-run"`')
    expect(report).toContain('`"command":"render-report"`')
    expect(report).not.toContain('Skill 自行渲染')
  })

  test('入口只消费 Engine WorkflowDecision，不维护第二份状态表', async () => {
    const text = await readFile(new URL('../skills/testing/e2e/SKILL.md', import.meta.url), 'utf8')

    for (const file of workflowFiles) {
      expect(text).toContain(`[${file}](${file})`)
    }
    expect(text).toContain('WorkflowDecision')
    expect(text).toContain('不得维护状态顺序或终态副本')
    expect(text).not.toContain('created → source-frozen')
    expect(text).toContain('Runtime Host')
    expect(text).toContain('doctor --json')
    expect(text).toContain('~/.mutil-skills/bin/repo-e2e rpc')
    expect(text).toContain('Skill 不计算 SHA、覆盖率、审批有效性、verdict 或发布状态')
    expect(text).toContain('docs-only')
  })

  test('诊断和审批子流程只声明 Engine 允许的回边', async () => {
    const diagnosis = await readFile(new URL('../skills/testing/e2e/diagnosis-healing.md', import.meta.url), 'utf8')
    const approval = await readFile(new URL('../skills/testing/e2e/execution-approval.md', import.meta.url), 'utf8')

    expect(diagnosis).toContain('`diagnosing → finalizing`')
    expect(diagnosis).not.toContain('`diagnosing → running-*`')
    expect(approval).toContain('先撤销旧 grant，再回到 `binding-draft`')
  })

  test('Attempt 诊断、报告与发布只信任 workflow-events v2 落盘链', async () => {
    const diagnosis = await readFile(new URL('../skills/testing/e2e/diagnosis-healing.md', import.meta.url), 'utf8')
    const report = await readFile(new URL('../skills/testing/e2e/report-verdict.md', import.meta.url), 'utf8')
    const transaction = await readFile(new URL('../skills/testing/e2e/artifact-transaction.md', import.meta.url), 'utf8')
    for (const text of [diagnosis, report, transaction]) {
      expect(text).toContain('workflow-events v2')
      expect(text).toContain('Attempt Authority')
    }
    expect(diagnosis).toContain('runId、retryPolicy、initialChainDigest')
    expect(diagnosis).toContain('时间单调')
    expect(report).toContain('selectedAttemptId')
    expect(report).toContain('diagnostics.attempts')
    expect(transaction).toContain('当前 staging')
    expect(transaction).toContain('不得复用首次构建 closure')
  })

  test('审批、Capability 与 cleanup 子流程使用当前 v2 安全契约', async () => {
    const approval = await readFile(new URL('../skills/testing/e2e/execution-approval.md', import.meta.url), 'utf8')
    const cleanup = await readFile(new URL('../skills/testing/e2e/data-and-cleanup.md', import.meta.url), 'utf8')
    const execution = await readFile(new URL('../skills/testing/e2e/browser-execution.md', import.meta.url), 'utf8')
    const gateway = await readFile(new URL('../skills/testing/e2e/safety-gateway.md', import.meta.url), 'utf8')

    expect(approval).toContain('approval projection')
    expect(approval).toContain('freshness receipt')
    expect(approval).toContain('发布前动态复验')
    expect(cleanup).toContain('`not-needed`、`verified-clean`、`failed`、`unknown`')
    expect(cleanup).not.toContain('签名记录 released/cleanup-failed/not-applicable')
    expect(execution).toContain('actionId + operation')
    expect(execution).toContain('多角色单代')
    expect(gateway).toContain('freshness receipt')
    expect(gateway).toContain('全部 capability')
  })

  test('Authority 身份、持久状态与运行时复验使用可重启且 fail-closed 的边界', async () => {
    const approval = await readFile(new URL('../skills/testing/e2e/execution-approval.md', import.meta.url), 'utf8')
    const cleanup = await readFile(new URL('../skills/testing/e2e/data-and-cleanup.md', import.meta.url), 'utf8')
    const execution = await readFile(new URL('../skills/testing/e2e/browser-execution.md', import.meta.url), 'utf8')
    const diagnosis = await readFile(new URL('../skills/testing/e2e/diagnosis-healing.md', import.meta.url), 'utf8')
    const transaction = await readFile(new URL('../skills/testing/e2e/artifact-transaction.md', import.meta.url), 'utf8')

    expect(approval).toContain('可信身份注册表')
    expect(approval).toContain('不得信任调用方自报 roles')
    expect(approval).toContain('LocalApprovalAuthority.open({ statePath, stateEncryptionKey, testWorkspaceRoots })')
    expect(approval).toContain('approvalSessionRef')
    expect(approval).toContain('AES-256-GCM')
    expect(approval).toContain('Git 外 Secret Provider')
    expect(cleanup).toContain('LocalLeaseAuthority.open({ statePath, testWorkspaceRoots })')
    expect(cleanup).toContain('重启后单调递增')
    expect(execution).toContain('write.verifyForSubject.v1')
    expect(execution).toContain('lease.verifyTarget.v1')
    expect(execution).toContain('authenticated-rpc')
    expect(execution).toContain('Authority RPC 公钥摘要')
    expect(execution).toContain('不接受调用方自报')
    expect(execution).toContain('production-isolated')
    expect(execution).toContain('test-only')
    expect(execution).toContain('grantValid/leaseValid')
    expect(execution).toContain('来源绑定')
    expect(execution).toContain('generationId')
    expect(diagnosis).toContain('appendAttemptEvent()')
    expect(diagnosis).toContain('不得提供任意摘要签名接口')
    expect(transaction).toContain('SQLite 持久状态')
    expect(transaction).toContain('nonce 使用计数')
    expect(transaction).toContain('fencing token')
    expect(transaction).toContain('错误密钥必须 fail closed')
  })

  test('Scope/Lineage 只接受专用 DecisionReceipt，旧签名与自引用投影不能自批', async () => {
    const scope = await readFile(new URL('../skills/testing/e2e/scope-approval.md', import.meta.url), 'utf8')
    const intake = await readFile(new URL('../skills/testing/e2e/prd-intake.md', import.meta.url), 'utf8')

    expect(scope).toContain('scope-decision-subject/v1')
    expect(scope).toContain('明确排除')
    expect(scope).toContain('scope-approver')
    expect(scope).toContain('通用 Artifact 签名')
    expect(scope).toContain('staging 发布前')
    expect(intake).toContain('lineage-decision-subject/v1')
    expect(intake).toContain('lineage-approver')
    expect(intake).toContain('lineage-decision-receipt/v1')
    expect(intake).toContain('migration-required')
  })

  test('Sanitizer 由单一 Runtime Host doctor 探针证明', async () => {
    const manifestText = await readFile(new URL('../skills/testing/e2e/skill.manifest.json', import.meta.url), 'utf8')
    const manifest = parseSkillManifest(JSON.parse(manifestText))
    expect(manifest.requires).toHaveLength(1)
    expect(manifest.requires[0]?.capability).toBe('e2e.runtime-host')
    expect(manifest.requires[0]?.satisfiedBy).toContain('verified installation manifest + protocol major + safety probes')
  })

  test('回归发布只接受受信编译器与隔离 discovery 专用证明', async () => {
    const regression = await readFile(new URL('../skills/testing/e2e/regression-publication.md', import.meta.url), 'utf8')

    expect(regression).toContain('regression-discovery-attestation/v2')
    expect(regression).toContain('projectCompilerInputFromArtifacts()')
    expect(regression).toContain('prepareTrustedCompilerRun()')
    expect(regression).toContain('真实 Source Set')
    expect(regression).toContain('playwrightAction')
    expect(regression).toContain('真实本地 Playwright CLI')
    expect(regression).toContain('源码 bytes')
    expect(regression).toContain('playwrightCaseIds')
    expect(regression).toContain('失败自动清理')
    expect(regression).toContain('固定 launcher 无论成功、失败或环境绑定拒绝都必须撤销 session 并清理')
    expect(regression).toContain('migration-required')
  })

  test('方案 B 将可信编译源码与普通手写测试分域，并在报告中暴露执行 Profile', async () => {
    const entry = await readFile(new URL('../skills/testing/e2e/SKILL.md', import.meta.url), 'utf8')
    const execution = await readFile(new URL('../skills/testing/e2e/browser-execution.md', import.meta.url), 'utf8')
    const report = await readFile(new URL('../skills/testing/e2e/report-verdict.md', import.meta.url), 'utf8')

    expect(entry).toContain('AI/Skill 只能产出声明式需求、Case、Action 与 Oracle')
    expect(execution).toContain('trusted-read-only')
    expect(execution).toContain('trusted-reversible-write')
    expect(execution).toContain('普通手写测试不能标记为 `trusted-*`')
    expect(report).toContain('final-report.regressionDetails')
  })

  test('Verdict 报告子流程要求三类审批和完整事实可追踪闭环', async () => {
    const report = await readFile(new URL('../skills/testing/e2e/report-verdict.md', import.meta.url), 'utf8')

    expect(report).toContain('scope、lineage、execution')
    expect(report).toContain('REQ→RULE→COV→CASE→STEP→EVIDENCE')
    expect(report).toContain('traceabilityMatrix')
    expect(report).toContain('dispositions')
    expect(report).toContain('独立重算')
    expect(report).toContain('缺失、重复、额外或错绑')
  })

  test('E2E workflow files stay local and preserve the TDD skill', () => {
    expect(listSkills().map((skill) => skill.id)).toEqual(['tdd', 'e2e'])
    expect(resolveSkill('tdd')?.files.map((file) => file.name)).toContain('tests.md')
    expect(resolveSkill('e2e')?.files.every((file) => file.relativePath.startsWith('skills/testing/e2e/'))).toBe(true)
  })
})
