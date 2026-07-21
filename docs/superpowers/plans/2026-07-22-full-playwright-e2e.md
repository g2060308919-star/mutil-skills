# Full Playwright E2E Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 新增显式 `full-playwright` 模式，允许冻结审批的测试程序使用完整 Playwright API，并通过 TodoMVC 官方 PRD/网站完成真实功能验收和报告闭环。

**Architecture:** 完整 Playwright 程序存入冻结 Execution Contract，并以 digest 投影到 Action Map、Approval Subject、Run Bundle 和 Regression Source Set。Runtime 为 browser-local reversible-write capability 建立 Authority reservation、Lease、Gateway、一次性 Chrome、证据、cleanup 和 outcome receipt；旧受控模式保持默认且不变。

**Tech Stack:** TypeScript 5.8、Zod、Playwright 1.61.1、Vitest、SQLite Authority、Runtime Gateway、Ed25519 attestation。

## Global Constraints

- `full-playwright` 必须显式选择，旧 Profile 不得自动升级。
- 完整 Playwright API 只指浏览器/Playwright 对象；Node host API、动态工具和任意环境读取继续禁止。
- source、cleanupSource、网络请求和 cleanup 必须进入冻结资产和 Execution Approval。
- 所有网络继续经过 Gateway；一次性 Profile 和 raw evidence 继续位于 Git 外。
- 已发生效果但结果或 cleanup 不明时禁止自动重试。
- TodoMVC 已知产品偏差必须报告，不得修改公开目标页面来制造通过。

---

### Task 1: Full Playwright Contracts

**Files:**
- Modify: `packages/e2e-contracts/src/compiler-input.ts`
- Modify: `packages/e2e-contracts/src/artifacts.ts`
- Modify: `packages/e2e-contracts/src/approval.ts`
- Modify: `packages/e2e-contracts/src/approval-freshness.ts`
- Modify: `packages/e2e-contracts/src/execution-outcome.ts`
- Modify: `packages/e2e-contracts/src/regression-discovery.ts`
- Test: `packages/e2e-contracts/test/compiler-input.test.ts`
- Test: `packages/e2e-contracts/test/artifacts.test.ts`
- Test: `packages/e2e-contracts/test/execution-outcome.test.ts`

**Interfaces:**
- Produces: `FullPlaywrightProgramSchema`, `FullPlaywrightCompilerActionSchema`, browser-local `ReversibleWriteCapability`, `executionProfile: 'full-playwright'`。

- [ ] 写失败测试：合法 full program 通过，source digest 错误、cleanup 缺失、旧 Profile 混用、HTTP/browser-local capability 字段串用均拒绝。
- [ ] 运行 `npx vitest run packages/e2e-contracts/test/compiler-input.test.ts packages/e2e-contracts/test/artifacts.test.ts packages/e2e-contracts/test/execution-outcome.test.ts`，确认 RED。
- [ ] 实现 Schema、类型、digest helper 与兼容 union；HTTP capability 行为保持不变。
- [ ] 重跑测试确认 GREEN，运行 `npm run typecheck`。
- [ ] 提交 `feat(e2e): define full playwright contracts`。

### Task 2: Authority Browser-Local Write Grant

**Files:**
- Modify: `packages/e2e-authority/src/local-approval-authority.ts`
- Modify: `packages/e2e-authority/src/authority-execution-rpc.ts`
- Modify: `packages/e2e-authority/src/trusted-execution-clients.ts`
- Test: `packages/e2e-authority/test/local-approval-authority.test.ts`
- Test: `packages/e2e-authority/test/authority-execution-rpc.test.ts`

**Interfaces:**
- Consumes: browser-local `ReversibleWriteCapability`。
- Produces: 与 HTTP 写相同的一次性 reservation/complete/unknown API；grant capability 保留 program/cleanup digest。

- [ ] 写失败测试：Authority 签发 browser-local grant、RPC 复验和 reservation；程序摘要变化、transport 变化、重复消费拒绝。
- [ ] 运行两个定向测试确认 RED。
- [ ] 扩展 grant 投影和 RPC parser，保持旧快照迁移兼容。
- [ ] 重跑测试和 typecheck 确认 GREEN。
- [ ] 提交 `feat(e2e): authorize browser local playwright writes`。

### Task 3: Projector and Deterministic Compiler

**Files:**
- Modify: `packages/e2e-playwright-runtime/src/compiler-input-projector.ts`
- Modify: `packages/e2e-playwright-runtime/src/compiler.ts`
- Modify: `packages/e2e-playwright-runtime/src/trusted-source-audit.ts`
- Modify: `packages/e2e-playwright-runtime/src/regression-discovery.ts`
- Test: `packages/e2e-playwright-runtime/test/compiler-input-projector.test.ts`
- Test: `packages/e2e-playwright-runtime/test/compiler.test.ts`
- Test: `packages/e2e-playwright-runtime/test/trusted-source-audit.test.ts`

**Interfaces:**
- Produces: 冻结 Action Map/Execution Contract 到 `FullPlaywrightCompilerAction` 的唯一投影；生成直接使用 Playwright fixture 的密封项目。

- [ ] 写失败测试：full source/cleanup 被逐字确定性生成；digest 或 profile 错误拒绝；Playwright API 允许，Node host/dynamic tooling 仍拒绝。
- [ ] 运行定向测试确认 RED。
- [ ] 实现 projector、compiler template、profile source audit 与 manifest。
- [ ] 重跑测试、typecheck 和 Source Set Golden 确认 GREEN。
- [ ] 提交 `feat(e2e): compile approved full playwright programs`。

### Task 4: Full Playwright Browser Runner

**Files:**
- Create: `packages/e2e-playwright-runtime/src/full-playwright-runner.ts`
- Modify: `packages/e2e-playwright-runtime/src/index.ts`
- Test: `packages/e2e-playwright-runtime/test/full-playwright-runner.test.ts`
- Create: `scripts/e2e-full-playwright.golden.test.ts`

**Interfaces:**
- Produces: `runFullPlaywrightCase()`，输入可信 session、program、Authority、Lease、Gateway、Page；输出 effectObservation、evidence、cleanup 和 result digest。

- [ ] 写失败测试覆盖 fill、press、check、click link、dblclick、hover、popup/context/request、expect、finally cleanup 和 unknown 防重试。
- [ ] 运行测试确认 RED。
- [ ] 实现程序编译、静态审计、固定 bindings、超时、证据和 cleanup；不得暴露 Node host bindings。
- [ ] 运行单元测试和真实 Chrome Golden 确认 GREEN。
- [ ] 提交 `feat(e2e): execute full playwright browser programs`。

### Task 5: Production Runtime Wiring

**Files:**
- Create: `packages/e2e-runtime/src/runtime-full-playwright-projector.ts`
- Modify: `packages/e2e-runtime/src/runtime-browser-wiring.ts`
- Modify: `packages/e2e-runtime/src/runtime-host.ts`
- Modify: `packages/e2e-runtime/src/cli.ts`
- Modify: `packages/e2e-runtime/src/trusted-action-runner.ts`
- Test: `packages/e2e-runtime/test/runtime-full-playwright-projector.test.ts`
- Test: `packages/e2e-runtime/test/runtime-browser-wiring.test.ts`
- Test: `packages/e2e-runtime/test/runtime-host.test.ts`

**Interfaces:**
- Consumes: frozen full action + browser-local SignedWriteGrant。
- Produces: 生产 execute-run 的完整 Authority→Lease→Gateway→Chrome→evidence→cleanup→outcome 闭环。

- [ ] 写失败测试：生产投影严格闭合；显式 profile 才路由 full runner；所有网络经过 Gateway；cleanup failed/unknown 隔离 lease。
- [ ] 运行定向测试确认 RED。
- [ ] 实现 projector、Runtime dispatch 和 production lifecycle。
- [ ] 重跑定向测试、typecheck、architecture 确认 GREEN。
- [ ] 提交 `feat(e2e): wire full playwright production runtime`。

### Task 6: Publication and Skill Workflow

**Files:**
- Modify: `packages/e2e-engine/src/generation-assembler.ts`
- Modify: `packages/e2e-runtime/src/runtime-finalization-material-sealer.ts`
- Modify: `packages/e2e-runtime/src/production-finalization-material-provider.ts`
- Modify: `packages/skills/skills/testing/e2e/browser-execution.md`
- Modify: `packages/skills/skills/testing/e2e/execution-approval.md`
- Modify: `packages/skills/skills/testing/e2e/report-verdict.md`
- Test: `packages/e2e-engine/test/generation-assembler.test.ts`
- Test: `packages/e2e-runtime/test/runtime-finalization-material-sealer.test.ts`
- Test: `packages/skills/test/e2e-skill.test.ts`

**Interfaces:**
- Produces: final report 显式记录 full-playwright、程序摘要、cleanup 和高权限警告。

- [ ] 写失败测试：缺程序摘要、cleanup receipt、full profile 标识或 evidence 时发布拒绝。
- [ ] 运行测试确认 RED。
- [ ] 扩展 finalization、report projection 和中文 Skill 指令。
- [ ] 重跑测试确认 GREEN。
- [ ] 提交 `feat(e2e): publish full playwright execution evidence`。

### Task 7: TodoMVC Public Functional Acceptance

**Files:**
- Create: `scripts/e2e-todomvc-full-playwright.golden.test.ts`
- Create: `docs/superpowers/specs/e2e-todomvc-full-playwright-acceptance.md`
- Modify: `vitest.e2e.config.ts`

**Interfaces:**
- Produces: 官方 PRD/网站的真实 Chrome 功能报告和可追踪资产。

- [ ] 固定官方 PRD/source SHA、页面响应摘要和唯一 Run 数据。
- [ ] 通过 full program 执行新增、trim、顺序、完成/取消、过滤、编辑、删除和 Clear completed。
- [ ] cleanup reload 后验证空列表并证明 Profile 删除。
- [ ] 把 Persistence、感叹号和 Escape 偏差记录为目标产品偏差，不伪造通过。
- [ ] 运行新 Golden；对每个真实缺口执行 red→green 修复，直到 Runtime 能稳定产生预期终态报告。
- [ ] 提交 `test(e2e): accept todomvc with full playwright runtime`。

### Task 8: Release Verification and Push

**Files:**
- Modify: relevant package `package.json` versions only if packaging contract changes require minor release。
- Modify: release/acceptance docs。

- [ ] 运行 `npm run build`、`npm run typecheck`、`npm run lint:architecture`。
- [ ] 运行 `npm test -- --reporter=dot`，沙箱权限测试在正确权限边界复验。
- [ ] 运行 `npm run e2e:golden` 和 TodoMVC public Golden。
- [ ] 运行 `npm pack --dry-run --workspaces`，验证所有 package 内容。
- [ ] 使用双轴 code review 审查基线 `a2565ac` 以来的变更，修复所有 P0/P1。
- [ ] 提交最终文档与版本变更，确认 worktree clean。
- [ ] 推送 `codex/e2e-local-browser-approval` 到 origin，并核对远程 SHA。
