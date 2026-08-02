# E2E Flow Reliability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 E2E Skill 通过高层接口完成可见、可配置、可恢复的 PRD 驱动浏览器验收，同时保持 Runtime、Authority、Gateway、可信 Compiler 和证据链的安全强度。

**Architecture:** 在现有严格 RPC 之上增加 Runtime-owned 深模块：Target Contract、声明式 Page Identity、Acceptance Review、Run Condition/Blocker、状态投影和 Facade。旧 Workflow 继续记录审计事件，新 Run Condition 独立表达可恢复阻断；Probe 与 Trusted Preflight 使用不同事实类型。所有新增外部输入先在 Contracts 校验，再由 Runtime 生成摘要、ID 和可信事实。

**Tech Stack:** TypeScript 5、Zod、Vitest、Playwright、Node.js 文件系统原子操作、现有 Runtime Host/Engine/Authority/Gateway/Report packages。

## Global Constraints

- Runtime Host 是唯一 RPC、工作流和恢复权威；Skill 不维护状态机。
- 不开放任意 JavaScript、`page.evaluate`、任意 Node/Playwright 源码或 shell 执行。
- Target Probe 只允许用户明确 origin 上的 GET/HEAD、静态导航和 DOM/ARIA 读取，不进入 Verdict。
- effect unknown 永不自动重试；页面、Binding、Fixture、请求或 Cleanup 主题变化必须使旧执行批准失效。
- 本地确认固定 `identityVerified=false`、`separationOfDutiesVerified=false`。
- 低层 `repo-e2e rpc` 保持严格兼容；高层接口不得吞掉 reasonCode/requestId/runId。
- 所有新生产函数先写失败测试并实际运行 RED，再写最小实现。

---

### Task 1: Target、Page Identity、Fixture 与 Run Projection Contracts

**Files:**
- Create: `packages/e2e-contracts/src/e2e-flow.ts`
- Modify: `packages/e2e-contracts/src/runtime-host.ts`
- Modify: `packages/e2e-contracts/src/declarative-prd-run.ts`
- Modify: `packages/e2e-contracts/src/index.ts`
- Test: `packages/e2e-contracts/test/e2e-flow.test.ts`
- Test: `packages/e2e-contracts/test/declarative-prd-run.test.ts`

**Interfaces:**
- Produces: `TargetContractSchema`, `PageIdentityPolicySchema`, `RunHandleSchema`, `RunStageSchema`, `RunConditionSchema`, `AcceptanceReviewSchema`, `FixtureContractSchema`, `ExecutionLaneSchema`, `SourceRoleSchema`。
- Produces: `normalizeTargetUrl(raw: string): string`，仅为缺少 scheme 的 ASCII localhost/127.0.0.1 增加 `http://`。
- Consumes: 现有 `DigestSchema` 语义和 `DeclarativePrdRunDesignSchema`。

- [ ] **Step 1: Write failing contract tests**

  覆盖：普通文本不能成为唯一身份；URL+test-id 合法；脚本/XPath/伪元素 selector 非法；localhost 规范化；全角冒号报字段错误；真实写 fixture 必须有 lease/cleanup/reload；injection fixture 不能声明真实 lane；RunHandle 四字段闭合。

- [ ] **Step 2: Run RED**

  Run: `npx vitest run packages/e2e-contracts/test/e2e-flow.test.ts packages/e2e-contracts/test/declarative-prd-run.test.ts --reporter=verbose`

  Expected: FAIL because `e2e-flow.js` exports and declarative fields do not exist.

- [ ] **Step 3: Implement schemas and extend declarative Case**

  `DeclarativeCaseSchema` 新增必填 `executionLane`、`pageIdentityPolicy`、`fixture`、`locatorCandidates`；Compiled Case 原样规范化携带这些声明式字段，但稳定 ID 和 digest 仍由 compiler 生成。

- [ ] **Step 4: Run GREEN and contract package typecheck**

  Run: `npx vitest run packages/e2e-contracts/test/e2e-flow.test.ts packages/e2e-contracts/test/declarative-prd-run.test.ts --reporter=verbose`

  Run: `npm run build --workspace @mutil-skills/e2e-contracts`

### Task 2: Configurable Page Identity Evaluator

**Files:**
- Create: `packages/e2e-playwright-runtime/src/page-identity-policy.ts`
- Modify: `packages/e2e-playwright-runtime/src/playwright-page-adapter.ts`
- Modify: `packages/e2e-playwright-runtime/src/read-only-runner.ts`
- Modify: `packages/e2e-playwright-runtime/src/write-runner.ts`
- Modify: `packages/e2e-playwright-runtime/src/index.ts`
- Test: `packages/e2e-playwright-runtime/test/page-identity-policy.test.ts`
- Test: `packages/e2e-playwright-runtime/test/read-only-runner.test.ts`
- Test: `packages/e2e-playwright-runtime/test/write-runner.test.ts`

**Interfaces:**
- Consumes: `PageIdentityPolicy`。
- Produces: `evaluatePageIdentity(page, policy): Promise<PageIdentityEvaluation>`，其中 evaluation 包含逐 signal expected/actual/matched、总体 matched 和 observed URL。
- Produces: `BrowserPageAdapter.evaluateIdentity(policy)`；保留旧 `identity()` 兼容现有 V1 subject。

- [ ] **Step 1: Write failing evaluator tests**

  使用真实最小 Playwright Page Adapter fake 验证 test-id、ARIA role/name、受限 CSS、普通可见文本、title/heading、`all`、`at-least`、URL path glob 和超时失败。

- [ ] **Step 2: Run RED**

  Run: `npx vitest run packages/e2e-playwright-runtime/test/page-identity-policy.test.ts --reporter=verbose`

- [ ] **Step 3: Implement evaluator and wire runners**

  V2 subject 使用 policy evaluator；V1 subject 继续使用原 URL/title/heading/ariaSignals 逻辑。业务 selector 只通过 Playwright locator 可见性检查，不执行 evaluate。

- [ ] **Step 4: Run GREEN and existing runner regression tests**

  Run: `npx vitest run packages/e2e-playwright-runtime/test/page-identity-policy.test.ts packages/e2e-playwright-runtime/test/read-only-runner.test.ts packages/e2e-playwright-runtime/test/write-runner.test.ts --reporter=verbose`

### Task 3: Target Contract and Untrusted Read-only Target Probe

**Files:**
- Create: `packages/e2e-runtime/src/target-contract.ts`
- Create: `packages/e2e-runtime/src/target-probe.ts`
- Modify: `packages/e2e-runtime/src/runtime-browser-wiring.ts`
- Modify: `packages/e2e-runtime/src/runtime-host.ts`
- Modify: `packages/e2e-runtime/src/run-store.ts`
- Modify: `packages/e2e-runtime/src/runtime-state-migration.ts`
- Test: `packages/e2e-runtime/test/target-contract.test.ts`
- Test: `packages/e2e-runtime/test/target-probe.test.ts`
- Test: `packages/e2e-runtime/test/runtime-host.test.ts`

**Interfaces:**
- Consumes: normalized `TargetContract` candidate from `create-run` or new `configure-target` RPC edge。
- Produces: Runtime-owned `TargetContractFact` with digest and derived environment identity。
- Produces: `authorizeTargetProbe(backend)` opaque capability and `runTargetProbe(capability, snapshot)`；返回 `untrusted-diagnostic` fact，不写 browser evidence。

- [ ] **Step 1: Write failing target tests**

  覆盖唯一环境摘要派生、Policy/Run/Discovery 不再接受互相矛盾的 environment ID、Probe 只允许显式 origin、shell reachability 不参与结果、Probe 不能写 trusted evidence。

- [ ] **Step 2: Run RED**

  Run: `npx vitest run packages/e2e-runtime/test/target-contract.test.ts packages/e2e-runtime/test/target-probe.test.ts --reporter=verbose`

- [ ] **Step 3: Implement Runtime modules and snapshot 1.8 migration**

  Snapshot 新增 `targetContract`、`targetProbe`；旧快照保持无这些字段，不伪造事实。Host 新增 `configure-target` 与 `probe-target` 命令，状态投影在目标未配置或 Probe 阻断时返回最小输入。

- [ ] **Step 4: Run GREEN and host tests**

  Run: `npx vitest run packages/e2e-runtime/test/target-contract.test.ts packages/e2e-runtime/test/target-probe.test.ts packages/e2e-runtime/test/runtime-host.test.ts --reporter=verbose`

### Task 4: Acceptance Review and Real Local Confirmation Receipt

**Files:**
- Create: `packages/e2e-runtime/src/acceptance-review.ts`
- Modify: `packages/e2e-contracts/src/runtime-host.ts`
- Modify: `packages/e2e-runtime/src/local-approval-confirmations.ts`
- Modify: `packages/e2e-runtime/src/runtime-host.ts`
- Modify: `packages/e2e-runtime/src/run-store.ts`
- Test: `packages/e2e-runtime/test/acceptance-review.test.ts`
- Test: `packages/e2e-runtime/test/runtime-host.test.ts`

**Interfaces:**
- Produces: `buildAcceptanceReview(snapshot): AcceptanceReview` from frozen source, prepared understanding and compiled PRD plan。
- Produces: RPC `get-acceptance-review` and `confirm-acceptance-review`。
- Persists: `acceptanceReview` and Authority/local-confirmation receipt bound to `reviewDigest`。

- [ ] **Step 1: Write failing tests**

  断言完整 SourceSpan→Clause→Requirement→Rule→Oracle→Case 映射；缺链拒绝；caller boolean 不构成回执；未确认时不能进入 Discovery/Preflight；review 内容变化使旧回执失效。

- [ ] **Step 2: Run RED**

  Run: `npx vitest run packages/e2e-runtime/test/acceptance-review.test.ts packages/e2e-runtime/test/runtime-host.test.ts --reporter=verbose -t 'acceptance review'`

- [ ] **Step 3: Implement review and confirmation edges**

  本地回执固定 approver `local-caller`、`identityVerified=false`、`separationOfDutiesVerified=false`；Execution Approval semanticReview 改为引用已确认 reviewDigest，仅展示执行差异。

- [ ] **Step 4: Run GREEN**

  Run: `npx vitest run packages/e2e-runtime/test/acceptance-review.test.ts packages/e2e-runtime/test/local-approval-confirmations.test.ts packages/e2e-runtime/test/runtime-host.test.ts --reporter=verbose`

### Task 5: Recoverable Preflight Blocker and Invalidation Matrix

**Files:**
- Create: `packages/e2e-runtime/src/run-condition.ts`
- Create: `packages/e2e-runtime/src/run-invalidation.ts`
- Modify: `packages/e2e-runtime/src/run-store.ts`
- Modify: `packages/e2e-runtime/src/runtime-state-migration.ts`
- Modify: `packages/e2e-runtime/src/runtime-host.ts`
- Modify: `packages/e2e-engine/src/workflow.ts`
- Test: `packages/e2e-runtime/test/run-condition.test.ts`
- Test: `packages/e2e-runtime/test/preflight-retry.test.ts`
- Test: `packages/e2e-engine/test/workflow.test.ts`

**Interfaces:**
- Produces: `projectRunStage(workflow): RunStage` and `classifyRunCondition(snapshot): RunCondition`。
- Produces: `invalidateRun(snapshot, change): RuntimeRunSnapshot` with changes `service-restart | page-identity | fixture-or-effects | target-origin | prd-revision`。
- Produces: RPC `retry-blocked` and `update-page-identity`。

- [ ] **Step 1: Write failing same-Run retry tests**

  最小回归必须复现 0.4.5/0.4.7 症状：`run-preflight` 得到 `E2E_RUNTIME_PAGE_MISMATCH` 后，同一 runId 可更新 policy、重新取得需要的 execution delta approval 并回到 preflight；Requirement/Rule/Oracle/compiled semantic IDs 不变。

- [ ] **Step 2: Run RED**

  Run: `npx vitest run packages/e2e-runtime/test/preflight-retry.test.ts --reporter=verbose`

- [ ] **Step 3: Implement blocker overlay and invalidation**

  不给 `environment-blocked` 增加无条件 Engine 回边。Host 在可恢复 preflight 结果上保留审计事件并将快照恢复点记录为 `preflight-readonly`；旧终态只作为历史事件，公共状态由 RunCondition 投影。安全/Artifact/unknown-write 阻断不能由通用 retry 处理。

- [ ] **Step 4: Run GREEN and recovery regressions**

  Run: `npx vitest run packages/e2e-runtime/test/preflight-retry.test.ts packages/e2e-runtime/test/runtime-recovery.test.ts packages/e2e-runtime/test/effect-unknown-recovery.test.ts packages/e2e-engine/test/workflow.test.ts --reporter=verbose`

### Task 6: RunHandle Isolation and Friendly Status Projection

**Files:**
- Create: `packages/e2e-runtime/src/run-handle.ts`
- Modify: `packages/e2e-contracts/src/runtime-host.ts`
- Modify: `packages/e2e-runtime/src/run-store.ts`
- Modify: `packages/e2e-runtime/src/runtime-host.ts`
- Test: `packages/e2e-runtime/test/run-handle.test.ts`
- Test: `packages/e2e-runtime/test/run-store.test.ts`

**Interfaces:**
- Produces: `createRunHandle(snapshot)` and `assertRunHandle(snapshot, handle)`。
- Extends: `RuntimeStatusResult` with `handle`、`stage`、`condition`、`preservedAssets`、`invalidatedAssets`、`semanticCases`、`remediation`。

- [ ] **Step 1: Write failing isolation tests**

  两个 Run 的 runId、revision、generation、requestId、approval、script 或 evidence 任一混用均拒绝；同字节 request 重放继续幂等。

- [ ] **Step 2: Run RED**

  Run: `npx vitest run packages/e2e-runtime/test/run-handle.test.ts packages/e2e-runtime/test/run-store.test.ts --reporter=verbose`

- [ ] **Step 3: Implement handle checks and projection**

- [ ] **Step 4: Run GREEN**

  Run: `npx vitest run packages/e2e-runtime/test/run-handle.test.ts packages/e2e-runtime/test/run-store.test.ts packages/e2e-runtime/test/protocol.test.ts --reporter=verbose`

### Task 7: Static Run Status Workspace and Report Taxonomy

**Files:**
- Create: `packages/e2e-report/src/run-status.ts`
- Create: `packages/e2e-runtime/src/run-status-publisher.ts`
- Modify: `packages/e2e-report/src/index.ts`
- Modify: `packages/e2e-runtime/src/runtime-host.ts`
- Modify: `packages/e2e-runtime/src/standalone-evidence-publisher.ts`
- Test: `packages/e2e-report/test/run-status.test.ts`
- Test: `packages/e2e-runtime/test/run-status-publisher.test.ts`

**Interfaces:**
- Produces: `renderRunStatus(projection)` returning byte-equivalent JSON facts rendered to Markdown/HTML。
- Produces: atomic private files `run-status.json/md/html` in Standalone Run Workspace。

- [ ] **Step 1: Write failing rendering tests**

  覆盖 environment-blocked、not-executed、business-failed、accepted 四类展示；HTML escape、无 CDN、三视图事实一致、默认 mode 0700/0600。

- [ ] **Step 2: Run RED**

  Run: `npx vitest run packages/e2e-report/test/run-status.test.ts packages/e2e-runtime/test/run-status-publisher.test.ts --reporter=verbose`

- [ ] **Step 3: Implement renderer and publisher**

  每次 Host 成功推进或写入 blocker 后原子更新状态；Interim Report 明确不是 Final Verdict。

- [ ] **Step 4: Run GREEN**

  Run: `npx vitest run packages/e2e-report/test/run-status.test.ts packages/e2e-runtime/test/run-status-publisher.test.ts packages/e2e-report/test/complete-report.test.ts --reporter=verbose`

### Task 8: High-level Facade and CLI

**Files:**
- Create: `packages/e2e-runtime/src/e2e-facade.ts`
- Modify: `packages/e2e-runtime/src/cli.ts`
- Modify: `packages/e2e-runtime/src/index.ts`
- Test: `packages/e2e-runtime/test/e2e-facade.test.ts`
- Test: `packages/e2e-runtime/test/secret-cli.test.ts`
- Test: `packages/e2e-runtime/test/protocol.test.ts`

**Interfaces:**
- Produces: `E2EFacade` methods specified by the design and CLI `run/status/retry/report`。
- Consumes: fixed absolute Runtime launcher and strict in-process Host protocol；CLI string input never enters shell interpolation。

- [ ] **Step 1: Write failing user-interface tests**

  覆盖 `repo-e2e run --prd ./prd.md --target localhost:3000`、字段级中文错误、reasonCode 保留、`status --run`、`retry --run`、`report --run` 和底层 `rpc` 无回归。

- [ ] **Step 2: Run RED**

  Run: `npx vitest run packages/e2e-runtime/test/e2e-facade.test.ts packages/e2e-runtime/test/secret-cli.test.ts --reporter=verbose`

- [ ] **Step 3: Implement Facade and CLI adapters**

  Facade 负责生成 requestId、跟随 `get-status`、解析最小输入并返回公共投影；不计算摘要、批准或 Verdict。

- [ ] **Step 4: Run GREEN**

  Run: `npx vitest run packages/e2e-runtime/test/e2e-facade.test.ts packages/e2e-runtime/test/secret-cli.test.ts packages/e2e-runtime/test/protocol.test.ts --reporter=verbose`

### Task 9: Installer Identity and Explainable Recovery

**Files:**
- Modify: `packages/e2e-runtime/src/runtime-installer.ts`
- Modify: `packages/e2e-runtime/src/runtime-install-recovery.ts`
- Modify: `packages/e2e-runtime/src/runtime-manifest.ts`
- Modify: `packages/e2e-runtime/src/runtime-doctor.ts`
- Modify: `packages/e2e-contracts/src/runtime-host.ts`
- Test: `packages/e2e-runtime/test/runtime-installer.test.ts`
- Test: `packages/e2e-runtime/test/runtime-doctor.test.ts`

**Interfaces:**
- Produces: stable install identity `{version, registryIntegrity, contentDigest, executableDigest}`。
- Extends: Doctor probe details with `recoverability`、`expected`、`actual`、`preservedState`。

- [ ] **Step 1: Write failing install tests**

  连续同包安装两次幂等；gzip metadata/普通权限变化不冲突；可执行位变化冲突；每个 kill point 的 dead owner 恢复；live/ambiguous owner 阻断并返回 phase；current pointer 唯一候选修复。

- [ ] **Step 2: Run RED**

  Run: `npx vitest run packages/e2e-runtime/test/runtime-installer.test.ts packages/e2e-runtime/test/runtime-doctor.test.ts --reporter=verbose`

- [ ] **Step 3: Implement stable identity and structured remediation**

- [ ] **Step 4: Run GREEN**

  Run: `npx vitest run packages/e2e-runtime/test/runtime-installer.test.ts packages/e2e-runtime/test/runtime-doctor.test.ts --reporter=verbose`

### Task 10: Skill Orchestration and Documentation

**Files:**
- Modify: `packages/skills/skills/testing/e2e/SKILL.md`
- Modify: `packages/skills/skills/testing/e2e/prd-understanding.md`
- Modify: `packages/skills/skills/testing/e2e/browser-preflight-binding.md`
- Modify: `packages/skills/skills/testing/e2e/execution-approval.md`
- Modify: `packages/skills/skills/testing/e2e/data-and-cleanup.md`
- Modify: `packages/skills/skills/testing/e2e/report-verdict.md`
- Test: `packages/skills/test/e2e-skill.test.ts`

**Interfaces:**
- Consumes: Facade public commands and Runtime status projection only。
- Produces: Chinese stage output showing AcceptanceReview before Trusted Preflight and execution delta approval after it。

- [ ] **Step 1: Write failing Skill tests**

  断言 Skill 不再要求手拼底层 envelope；恰好一次 understand-prd；Review 未确认不执行 Preflight；Probe 阻断仍展示 Semantic Case；retry 使用同 RunHandle；报告区分 blocked/not-executed/failed。

- [ ] **Step 2: Run RED**

  Run: `npx vitest run packages/skills/test/e2e-skill.test.ts --reporter=verbose`

- [ ] **Step 3: Rewrite orchestration docs around Facade**

  子流程继续按需加载，但不重复 Runtime 状态机或低层命令顺序。

- [ ] **Step 4: Run GREEN**

  Run: `npx vitest run packages/skills/test/e2e-skill.test.ts --reporter=verbose`

### Task 11: Migration, Cross-repo Golden and Release Closure

**Files:**
- Modify: `packages/e2e-runtime/src/runtime-state-migration.ts`
- Modify: `packages/e2e-runtime/test/runtime-state-migration.test.ts`
- Create: `scripts/e2e-recoverable-localhost.golden.test.ts`
- Modify: `scripts/e2e-runtime-cross-repo.ts`
- Modify: `scripts/run-e2e-release.mjs`
- Modify: `CHANGELOG.md`
- Modify: `CONTEXT.md`
- Create: `docs/adr/0010-e2e-target-probe-and-recoverable-preflight.md`

**Interfaces:**
- Proves: clean HOME install, system Chrome, local target only browser-reachable, non-heading identity, AcceptanceReview confirmation, mismatch/retry same Run, multi Case, JSON write, Cleanup, Reload, screenshots, Trace and final reports。

- [ ] **Step 1: Write failing migration and Golden assertions**

  旧 Snapshot 只读且不伪造新事实；新 Snapshot 完整闭合；Golden 必须零条件 skip，并显式断言同 RunHandle 恢复和旧语义资产 digest 保持不变。

- [ ] **Step 2: Run focused RED then implement migration/Golden wiring**

  Run: `npx vitest run packages/e2e-runtime/test/runtime-state-migration.test.ts scripts/e2e-recoverable-localhost.golden.test.ts --reporter=verbose`

- [ ] **Step 3: Run focused GREEN**

  Run: `npx vitest run packages/e2e-runtime/test/runtime-state-migration.test.ts scripts/e2e-recoverable-localhost.golden.test.ts --reporter=verbose`

- [ ] **Step 4: Run complete verification**

  Run: `npm run build`

  Run: `npm test`

  Run: `npm run test:e2e:release`

- [ ] **Step 5: Review and commit**

  使用 `code-review` 对规格到实现、兼容、安全不变量、测试真实性和工作区清洁度做完整审查。修复发现后提交到当前分支。
