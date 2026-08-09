import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { describe, expect, test } from 'vitest'
import { parseSkillManifest } from '../../schema/src/index.js'
import { listSkills, resolveSkill, resolveSkillDirectory } from '../src/index.js'

const workflowFiles = [
  'prd-understanding.md',
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
          action: 'prompt-install', package: '@mutil-skills/e2e-runtime', version: '0.7.0',
          terminalState: 'environment-blocked', reasonCode: 'E2E_RUNTIME_HOST_UNAVAILABLE',
        },
      }],
      source: {
        url: 'https://github.com/g2060308919-star/mutil-skills/blob/v0.7.0/packages/skills/skills/testing/e2e/SKILL.md',
        rawUrl: 'https://raw.githubusercontent.com/g2060308919-star/mutil-skills/v0.7.0/packages/skills/skills/testing/e2e/SKILL.md',
        ref: 'v0.7.0',
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

  test('只调用一次 understand-prd，并把同一已确认契约投影交给 Runtime 校验', async () => {
    const entry = await readFile(new URL('../skills/testing/e2e/SKILL.md', import.meta.url), 'utf8')
    const adapter = await readFile(new URL('../skills/testing/e2e/prd-understanding.md', import.meta.url), 'utf8')
    const intake = await readFile(new URL('../skills/testing/e2e/prd-intake.md', import.meta.url), 'utf8')

    expect(entry).toContain('`$understand-prd`')
    expect(entry).toContain('恰好调用一次')
    expect(entry).toContain('若该外部 Skill 不可用')
    expect(entry).toContain('两条路径互斥')
    expect(entry).toContain('[prd-understanding.md](prd-understanding.md)')
    expect(entry).toContain('不得再次运行 `$understand-prd`')
    for (const text of [adapter, intake]) {
      expect(text).toContain('sourceRevision')
      expect(text).toContain('projectionDigest')
      expect(text).toContain('confirmed-by-caller')
      expect(text).toContain('Runtime')
    }
    expect(adapter).toContain('source-fact')
    expect(adapter).toContain('confirmed-decision')
    expect(adapter).toContain('pendingQuestions')
    expect(adapter).toContain('understandingContractDigest')
    expect(adapter).toContain('唯一不可变 prepared projection')
    expect(adapter).toContain('contractNodeIds')
    expect(adapter).toContain('contractAcceptanceCriteria')
    expect(adapter).toContain('e2e-contract-machine-view:v1')
    expect(adapter).toContain('Execution Approval')
    expect(adapter).toContain('不是第二次 PRD 理解')
  })

  test('入口使用严格成功投影并把恢复、报告渲染建模为真实 Runtime 命令', async () => {
    const text = await readFile(new URL('../skills/testing/e2e/SKILL.md', import.meta.url), 'utf8')

    for (const field of ['state', 'nextEdge', 'verifiedDigests', 'minimumMissingInput']) {
      expect(text).toContain(`\`${field}\``)
    }
    expect(text).toContain('`"command":"resume-run"`')
    expect(text).toContain('`"command":"render-report"`')
    expect(text).toContain('`prepare-manual-result`')
    expect(text).toContain('`finalize-manual-result-role`')
    expect(text).toContain('`finalize-run`')
    expect(text).toContain('每个业务命令成功后必须立即调用 `get-status`')
    expect(text).toContain('拒绝未知字段')
    expect(text).toContain('不得把 `approved: true` 当作审批')
  })

  test('默认使用系统 Chrome 与本地确认，不把 WebAuthn 登记设为必经步骤', async () => {
    const entry = await readFile(new URL('../skills/testing/e2e/SKILL.md', import.meta.url), 'utf8')
    const approval = await readFile(new URL('../skills/testing/e2e/execution-approval.md', import.meta.url), 'utf8')
    const browser = await readFile(new URL('../skills/testing/e2e/browser-execution.md', import.meta.url), 'utf8')

    expect(entry).toContain('configure-browser --system')
    expect(entry).toContain('configure-approval --mode local-confirmation')
    expect(entry).toContain('默认流程不执行 `identity enroll`')
    expect(entry).toContain('`confirmation-required`')
    expect(entry).toContain('必须暂停并等待调用者明确确认')
    expect(entry).toContain('@mutil-skills/e2e-runtime@0.7.0')
    expect(entry).not.toContain('Runtime 0.5.x')
    expect(entry).not.toContain('同为 `0.5.x`')
    expect(approval).toContain('`confirm-approval`')
    expect(approval).toContain('本地确认不验证自然人身份，也不证明职责分离')
    expect(browser).toContain('系统 Google Chrome')
    expect(browser).toContain('一次性 Profile')
    expect(browser).toContain('不读取或改变日常 Chrome Profile')
  })

  test('报告必须展示实际审批保障，不能把本地调用者确认写成身份审批', async () => {
    const report = await readFile(new URL('../skills/testing/e2e/report-verdict.md', import.meta.url), 'utf8')

    for (const field of ['approvalMode', 'identityVerified', 'separationOfDutiesVerified']) {
      expect(report).toContain(`\`${field}\``)
    }
    expect(report).toContain('本地确认（不验证身份/职责分离）')
    expect(report).toContain('WebAuthn 仅作为显式增强模式')
  })

  test('恢复与报告子流程只能调用真实 Runtime 命令', async () => {
    const diagnosis = await readFile(new URL('../skills/testing/e2e/diagnosis-healing.md', import.meta.url), 'utf8')
    const transaction = await readFile(new URL('../skills/testing/e2e/artifact-transaction.md', import.meta.url), 'utf8')
    const report = await readFile(new URL('../skills/testing/e2e/report-verdict.md', import.meta.url), 'utf8')

    expect(diagnosis).toContain('`"command":"resume-run"`')
    expect(transaction).toContain('`"command":"resume-run"`')
    expect(report).toContain('`"command":"render-report"`')
    expect(report).toContain('`prepare-manual-result`')
    expect(report).toContain('`finalize-manual-result-role`')
    expect(report).toContain('`finalize-run`')
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
    expect(report).toContain('CLAUSE→REQ→RULE→ORACLE→COV→CASE→STEP→CHECKPOINT→EVIDENCE')
    expect(report).toContain('traceabilityMatrix')
    expect(report).toContain('dispositions')
    expect(report).toContain('独立重算')
    expect(report).toContain('缺失、重复、额外或错绑')
  })

  test('P0 语义完整性要求 Clause 逐条处置、原子 Rule/Oracle 与多维 obligation 闭合', async () => {
    const entry = await readFile(new URL('../skills/testing/e2e/SKILL.md', import.meta.url), 'utf8')
    const intake = await readFile(new URL('../skills/testing/e2e/prd-intake.md', import.meta.url), 'utf8')
    const scope = await readFile(new URL('../skills/testing/e2e/scope-approval.md', import.meta.url), 'utf8')
    const model = await readFile(new URL('../skills/testing/e2e/requirement-oracles.md', import.meta.url), 'utf8')
    const coverage = await readFile(new URL('../skills/testing/e2e/coverage-universe.md', import.meta.url), 'utf8')

    expect(entry).toContain('Clause 原文与处置 → Requirement → Rule → Oracle')
    expect(intake).toContain('Clause Inventory')
    expect(intake).toContain('sourceSpan')
    expect(intake).toContain('inventoryDigest')
    expect(scope).toContain('每个 Clause 恰好一次')
    for (const disposition of ['modeled', 'excluded', 'not-applicable', 'ambiguous']) {
      expect(scope).toContain(`\`${disposition}\``)
    }
    expect(model).toContain('每个 modeled Clause')
    expect(model).toContain('每条 Rule 恰好绑定一个 Oracle')
    expect(model).toContain('`ruleId`')
    expect(model).toContain('`sourceRefs`')
    for (const field of ['clauseIds', 'ruleIds', 'oracleIds']) {
      expect(coverage).toContain(`\`${field}\``)
    }
  })

  test('P0 执行审批、Runtime checkpoint 与三格式报告展示同一条可追踪语义链', async () => {
    const approval = await readFile(new URL('../skills/testing/e2e/execution-approval.md', import.meta.url), 'utf8')
    const execution = await readFile(new URL('../skills/testing/e2e/browser-execution.md', import.meta.url), 'utf8')
    const report = await readFile(new URL('../skills/testing/e2e/report-verdict.md', import.meta.url), 'utf8')

    expect(approval).toContain('Clause 原文、sourceSpan、处置')
    expect(approval).toContain('Clause 原文与处置 → Requirement → Rule → Oracle')
    for (const field of ['checkpointId', 'oracleId', 'expectedJson', 'actualJson', 'evidenceIds']) {
      expect(execution).toContain(`\`${field}\``)
    }
    expect(execution).toContain('每个冻结 checkpoint 恰好执行一次')
    expect(execution).toContain('Host 复算')
    expect(report).toContain('CLAUSE→REQ→RULE→ORACLE→COV→CASE→STEP→CHECKPOINT→EVIDENCE')
    for (const file of ['final-report.json', 'final-report.md', 'final-report.html', 'manifest.json']) {
      expect(report).toContain(`\`${file}\``)
    }
  })

  test('入口用友好门面驱动状态、语义确认、恢复和报告，调用者不手写 envelope', async () => {
    const entry = await readFile(new URL('../skills/testing/e2e/SKILL.md', import.meta.url), 'utf8')

    for (const command of ['status --run', 'review --run', 'confirm-review --run', 'retry --run', 'report --run']) {
      expect(entry).toContain(command)
    }
    expect(entry).toContain('调用者不需要构造 `RuntimeRequestEnvelope`')
    expect(entry).toContain('Facade')
    expect(entry).toContain('reasonCode')
    expect(entry).toContain('remediation')
  })

  test('0.7 工作流以高层编译和目标探测为主线，submit-candidate 只服务旧 Run', async () => {
    const entry = await readFile(new URL('../skills/testing/e2e/SKILL.md', import.meta.url), 'utf8')

    expect(entry).toContain('## Runtime 0.7.x 工作流契约')
    for (const command of [
      'create-run', 'prepare-prd-understanding', 'compile-prd-run',
      'configure-target', 'probe-target', 'get-acceptance-review',
      'confirm-acceptance-review',
    ]) {
      expect(entry).toContain(`\`${command}\``)
    }
    expect(entry).toContain('`submit-candidate` 不属于新 Run 的默认主线')
    expect(entry).toContain('Skill 版本与 Runtime 版本必须同为 `0.7.x`')
  })

  test('调用者只提供 PRD 与目标地址，Skill 自动准备并冻结 Runtime 输入材料', async () => {
    const entry = await readFile(new URL('../skills/testing/e2e/SKILL.md', import.meta.url), 'utf8')
    const understanding = await readFile(new URL('../skills/testing/e2e/prd-understanding.md', import.meta.url), 'utf8')
    const intake = await readFile(new URL('../skills/testing/e2e/prd-intake.md', import.meta.url), 'utf8')

    for (const text of [entry, understanding, intake]) {
      expect(text).toContain('不得要求调用者手工创建')
      expect(text).toContain('.biztest/project.json')
      expect(text).toContain('requirements contract')
      expect(text).toContain('project policy')
    }
    expect(entry).toContain('调用者的最小输入')
    expect(entry).toContain('repo-e2e prepare-input')
    expect(entry).toContain('不联网、不重新理解 PRD')
    expect(understanding).toContain('URL 来源只抓取一次')
    expect(intake).toContain('validationIssues')
  })

  test('Target Probe 按 lane 和历史诊断升级策略并生成可行动中间报告', async () => {
    const preflight = await readFile(new URL('../skills/testing/e2e/browser-preflight-binding.md', import.meta.url), 'utf8')
    const diagnosis = await readFile(new URL('../skills/testing/e2e/diagnosis-healing.md', import.meta.url), 'utf8')

    for (const strategy of ['resource-closure', 'application-ready', 'dom-identity']) {
      expect(preflight).toContain(`\`${strategy}\``)
    }
    expect(preflight).toContain('preview-readonly')
    expect(preflight).toContain('WebSocket')
    expect(preflight).toContain('业务动作：未执行')
    expect(diagnosis).toContain('重复同一策略')
    expect(diagnosis).toContain('run-status.html')
  })

  test('语义审查发生在浏览器预检之前并明确隔离目标、参考与依赖来源', async () => {
    const entry = await readFile(new URL('../skills/testing/e2e/SKILL.md', import.meta.url), 'utf8')
    const understanding = await readFile(new URL('../skills/testing/e2e/prd-understanding.md', import.meta.url), 'utf8')

    expect(entry).toContain('AcceptanceReview')
    expect(entry).toContain('浏览器预检前')
    expect(entry).toContain('PRD 原文 → Clause 原文与处置 → Requirement → Rule → Oracle → Case')
    expect(entry).toContain('确认前不得执行 Discovery、可信浏览器预检或 locator 绑定')
    for (const role of ['target', 'reference', 'necessary-dependency']) {
      expect(understanding).toContain(`\`${role}\``)
    }
    expect(understanding).toContain('参考页面不得进入验收范围')
  })

  test('页面身份支持业务选择器、浏览器侧 localhost 探测与同 Run 修订恢复', async () => {
    const preflight = await readFile(new URL('../skills/testing/e2e/browser-preflight-binding.md', import.meta.url), 'utf8')

    for (const signal of ['test-id', 'role', 'css-visible', 'visible-text', 'title', 'heading']) {
      expect(preflight).toContain(`\`${signal}\``)
    }
    expect(preflight).toContain('TargetContract')
    expect(preflight).toContain('Target Probe')
    expect(preflight).toContain('命令行无法访问 localhost 不能判定目标不可用')
    expect(preflight).toContain('同一 Run')
    expect(preflight).toContain('preservedAssets')
    expect(preflight).toContain('invalidatedAssets')
    expect(preflight).toContain('E2E_RUNTIME_PAGE_MISMATCH')
  })

  test('中间状态与最终报告对用户可见并严格区分阻断、未执行和业务失败', async () => {
    const entry = await readFile(new URL('../skills/testing/e2e/SKILL.md', import.meta.url), 'utf8')
    const report = await readFile(new URL('../skills/testing/e2e/report-verdict.md', import.meta.url), 'utf8')

    expect(entry).toContain('run-status.html')
    expect(entry).toContain('semanticCases')
    for (const state of ['环境阻断', '未执行', '业务失败']) {
      expect(report).toContain(state)
    }
    expect(report).toContain('目标网站')
    expect(report).toContain('PRD 来源')
    expect(report).toContain('测试用例')
    expect(report).toContain('截图')
    expect(report).toContain('Playwright Trace')
  })

  test('E2E workflow files stay local and preserve the TDD skill', () => {
    expect(listSkills().map((skill) => skill.id)).toEqual(['tdd', 'e2e'])
    expect(resolveSkill('tdd')?.files.map((file) => file.name)).toContain('tests.md')
    expect(resolveSkill('e2e')?.files.every((file) => file.relativePath.startsWith('skills/testing/e2e/'))).toBe(true)
  })
})
