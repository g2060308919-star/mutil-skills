# E2E 系统 Chrome 与本地确认模式实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把默认 E2E 使用路径改为“系统 Google Chrome + Runtime 一次性 Profile + Gateway + 本地确认”，保留托管 Chromium 和 WebAuthn 作为显式增强/兜底，并让最终测试资产与报告准确表达实际保证等级。

**Architecture:** Browser Selection 与 Approval Mode 是用户级、版本化、严格校验的 Runtime 配置；每个 Run 冻结审批模式。系统 Chrome 只提供可执行文件，受控会话仍完全复用 Runtime 的 Profile supervisor、Gateway canary、owned-resource recovery 和能力证明。审批由 Runtime Host 统一判定自动批准、二阶段本地确认或 WebAuthn，Authority 仍签发并验证不可变 receipt/grant。报告从已认证事实投影保证等级，不接受展示层自报。

**Tech Stack:** TypeScript 5.8、Node.js 24、Zod 3.25、Vitest 3.2、Playwright 1.61.1、现有 Runtime/Authority/Gateway/Engine/Report 与 POSIX 安全文件工具。

## 全局约束

- 七个 E2E package 统一为 `0.2.0`，内部依赖使用精确 `0.2.0`。
- 严格执行 RED→GREEN；每项生产行为先观察定向测试失败。
- 默认不下载浏览器、不读取日常 Chrome Profile、不连接已打开的 Chrome。
- 系统 Chrome 与托管 Chromium 必须进入同一个 `ControlledBrowserHost`，使用同一 Gateway 与一次性 Profile 生命周期。
- `local-confirmation` 不声明自然人身份验证或职责分离；`webauthn` 保留现有保证。
- 旧 Run 缺少模式时迁移为 `webauthn`；旧托管 Chromium 可迁移成明确 selection，禁止改变旧审批含义。
- 生产环境、不可逆行为、未知 effect 始终 fail closed。
- 每项任务完成后运行定向测试和 `npm run typecheck`，创建原子提交。

---

### Task 1：用户级 Browser Selection 与 Approval Mode 严格状态

**Files:**
- Create: `packages/e2e-runtime/src/runtime-user-config.ts`
- Create: `packages/e2e-runtime/test/runtime-user-config.test.ts`
- Modify: `packages/e2e-runtime/src/runtime-layout.ts`
- Modify: `packages/e2e-runtime/src/index.ts`

**Interfaces:**
- `BrowserSelectionSchema`：`system-chrome | managed-chromium` 严格联合，绑定 version/digest/Runtime/proof/configuredAt。
- `ApprovalModeSchema`：`local-confirmation | webauthn`；配置缺失时默认本地模式。
- `read/writeBrowserSelection()`、`read/writeApprovalMode()`：私有目录、no-follow、0600、临时文件 + rename 原子写。

- [x] 写失败测试：拒绝额外字段、相对路径、坏摘要、符号链接、不安全权限；默认 approval mode 为本地；写入可重读且权限正确。
- [x] 运行 `npx vitest run packages/e2e-runtime/test/runtime-user-config.test.ts`，确认 RED。
- [x] 实现最小严格状态存储并导出。
- [x] 运行定向测试与 `npm run typecheck`。
- [x] Commit：`feat(e2e): add strict browser and approval configuration`

### Task 2：系统 Google Chrome 发现、验证和选择

**Files:**
- Create: `packages/e2e-runtime/src/system-chrome.ts`
- Create: `packages/e2e-runtime/test/system-chrome.test.ts`
- Modify: `packages/e2e-runtime/src/browser-installer.ts`
- Modify: `packages/e2e-runtime/src/index.ts`

**Interfaces:**
- `discoverSystemChrome()`：仅固定 macOS/Linux allowlist。
- `inspectSystemChrome()`：绝对路径 canonicalize、regular executable、owner、非 group/world writable、非项目内、digest/version。
- `BrowserInstallation`：统一 `system-chrome` 与 `managed-chromium`，保留启动所需 closure/executable digest。

- [x] 写失败测试：allowlist 顺序、显式路径、相对/项目内/symlink swap/错误 owner/可写文件拒绝、digest 与版本绑定。
- [x] 运行 `npx vitest run packages/e2e-runtime/test/system-chrome.test.ts packages/e2e-runtime/test/browser-installer.test.ts`，确认 RED。
- [x] 实现系统 Chrome 检查与统一浏览器安装投影。
- [x] 运行定向测试与 typecheck。
- [x] Commit：`feat(e2e): support verified system Google Chrome`

### Task 3：系统 Chrome 受控启动、Profile 清理与能力证明

**Files:**
- Modify: `packages/e2e-runtime/src/browser-host.ts`
- Modify: `packages/e2e-runtime/src/runtime-browser-wiring.ts`
- Modify: `packages/e2e-runtime/src/runtime-capability-proof.ts`
- Modify: `packages/e2e-runtime/test/browser-host.test.ts`
- Modify: `packages/e2e-runtime/test/runtime-browser-wiring.test.ts`
- Modify: `packages/e2e-runtime/test/runtime-capability-proof.test.ts`

**Interfaces:**
- `ControlledBrowserHost.open()` 接受统一 `BrowserInstallation`，measurement 绑定 source、可执行摘要与 launch policy。
- 每次会话创建 `0700 profile-<uuid>`、owner marker；确认进程关闭后删除，超时保留给 recovery。
- 配置系统 Chrome 时运行临时 Gateway、direct-bypass canary、profile cleanup proof，成功后才持久化 selection。

- [x] 写失败测试：两种来源共享 launch/profile；日常 Profile canary 不可见；正常删除；未确认关闭保留；proof 绑定 source。
- [x] 运行三个定向测试文件，确认 RED。
- [x] 实现统一 host 与 capability proof。
- [x] 运行定向测试、现有 Gateway 安全测试与 typecheck。
- [x] Commit：`feat(e2e): bind system Chrome to controlled browser isolation`

### Task 4：CLI 浏览器/审批配置与 Doctor 模式感知

**Files:**
- Modify: `packages/e2e-runtime/src/cli.ts`
- Modify: `packages/e2e-runtime/src/runtime-doctor.ts`
- Modify: `packages/e2e-contracts/src/runtime-host.ts`
- Modify: `packages/e2e-runtime/test/runtime-doctor.test.ts`
- Modify: `packages/e2e-runtime/test/protocol.test.ts`
- Modify: `packages/e2e-runtime/test/runtime-layout.test.ts`

**Interfaces:**
- `repo-e2e configure-browser --system [--executable ABS]`；失败不调用 download。
- `install-browser` 成功后显式选择 `managed-chromium`。
- `repo-e2e configure-approval --mode ...`。
- Doctor 输出 `browserSource`、`approvalMode`；系统 Chrome 每次重验 path/version/digest；本地模式 enrollment 不影响 ready。

- [ ] 写失败测试：CLI 参数闭包、无静默 fallback、系统 Chrome 更新返回 `E2E_SYSTEM_CHROME_REVALIDATION_REQUIRED`、本地模式无 credential 仍 ready、WebAuthn 模式继续阻断。
- [ ] 运行定向测试，确认 RED。
- [ ] 实现 CLI/Doctor 与严格公共输出。
- [ ] 运行定向测试和 typecheck。
- [ ] Commit：`feat(e2e): configure browser and approval modes`

### Task 5：审批保证 Contracts、风险分级与本地处置函数

**Files:**
- Create: `packages/e2e-contracts/src/approval-assurance.ts`
- Create: `packages/e2e-contracts/test/approval-assurance.test.ts`
- Create: `packages/e2e-runtime/src/local-approval-policy.ts`
- Create: `packages/e2e-runtime/test/local-approval-policy.test.ts`
- Modify: `packages/e2e-contracts/src/runtime-host.ts`
- Modify: `packages/e2e-contracts/src/index.ts`
- Modify: `packages/e2e-contracts/src/artifacts.ts`

**Interfaces:**
- `ApprovalMode`、`ApprovalAssurance`、`LocalApprovalSummary`、`OpenApprovalResult` 严格 schema。
- RPC 新增 `confirm-approval`。
- `localApprovalDisposition(subject, policy)` 只允许已知、非生产、纯只读自动批准；写/注入/隐私/人工需确认；未知/生产/不可逆阻断。

- [ ] 写失败测试：严格联合、summary 禁止敏感字段、riskTier 缺失按 production、纯只读/高风险/未知矩阵。
- [ ] 运行定向测试，确认 RED。
- [ ] 实现 Contracts 与纯函数。
- [ ] 运行定向测试和 typecheck。
- [ ] Commit：`feat(e2e): define local approval assurance and policy`

### Task 6：Runtime Host 两阶段本地确认与 Authority 签发

**Files:**
- Create: `packages/e2e-runtime/src/local-approval-confirmations.ts`
- Create: `packages/e2e-runtime/test/local-approval-confirmations.test.ts`
- Modify: `packages/e2e-runtime/src/runtime-host.ts`
- Modify: `packages/e2e-runtime/src/authority-host.ts`
- Modify: `packages/e2e-runtime/src/run-store.ts`
- Modify: `packages/e2e-authority/src/local-approval-authority.ts`
- Modify: `packages/e2e-runtime/test/runtime-host.test.ts`
- Modify: `packages/e2e-runtime/test/authority-host.test.ts`

**Interfaces:**
- Run 创建时冻结 `approvalMode`。
- `open-approval`：本地只读直接 Authority 签发；高风险写入 subject-bound confirmation challenge；WebAuthn 走旧路径。
- `confirm-approval`：Run lock 内重验项目/安装/workflow/subject/expiry，一次性消费并复用现有签名/finalization recovery。
- 本地 approver 严格为 `{kind:'local-caller'}`，WebAuthn identity 保持旧字段与角色验证。

- [ ] 写失败测试：自动批准、challenge、主题变化、过期、replay、跨项目、Authority 已签发但 Run Store 未落盘恢复。
- [ ] 运行定向测试，确认 RED。
- [ ] 实现确认 store、Host 路由与 Authority 本地签发入口。
- [ ] 运行定向测试、Authority grant/receipt/replay 测试和 typecheck。
- [ ] Commit：`feat(e2e): implement subject-bound local confirmations`

### Task 7：人工结果本地双确认与 WebAuthn 兼容

**Files:**
- Modify: `packages/e2e-contracts/src/manual-result.ts`
- Modify: `packages/e2e-authority/src/local-approval-authority.ts`
- Modify: `packages/e2e-runtime/src/runtime-host.ts`
- Modify: `packages/e2e-runtime/src/authority-host.ts`
- Modify: `packages/e2e-contracts/test/manual-result.test.ts`
- Modify: `packages/e2e-authority/test/manual-result.test.ts`
- Modify: `packages/e2e-runtime/test/manual-result-store.test.ts`

**Interfaces:**
- 人工结果 Authority proof 记录 approval mode 与 assurance。
- 本地模式允许同一 caller 分别确认 executor/reviewer challenge，但 session/confirmation 必须不同。
- WebAuthn 模式仍要求不同登记身份与原角色。

- [ ] 写失败测试：本地同 caller 两次独立确认可签发但职责分离 false；复用确认拒绝；WebAuthn 同身份继续拒绝。
- [ ] 运行定向测试，确认 RED。
- [ ] 实现 mode-aware manual finalization。
- [ ] 运行定向测试和 typecheck。
- [ ] Commit：`feat(e2e): support local manual result confirmations`

### Task 8：报告保证等级、审计与展示

**Files:**
- Modify: `packages/e2e-contracts/src/artifacts.ts`
- Modify: `packages/e2e-engine/src/complete-generation-builder.ts`
- Modify: `packages/e2e-engine/src/generation-audit.ts`
- Modify: `packages/e2e-report/src/complete-report.ts`
- Modify: `packages/e2e-engine/test/complete-generation-builder.test.ts`
- Modify: `packages/e2e-engine/test/generation-audit.test.ts`
- Modify: `packages/e2e-report/test/complete-report.test.ts`
- Modify: `packages/e2e-report/test/final-report.fixture.ts`

**Interfaces:**
- 每项审批和 FinalReport 暴露 `approvalMode`、`identityVerified`、`separationOfDutiesVerified`。
- Builder 从 Authority/Run 冻结事实投影；Auditor 独立复算；Markdown/HTML 清楚显示有限保证。

- [ ] 写失败测试：本地模式固定 false/false，伪造 true 被审计阻断；WebAuthn verified 事实可为 true；两个 renderer 同值。
- [ ] 运行定向测试，确认 RED。
- [ ] 实现 schema、builder、auditor 与 renderer。
- [ ] 重新生成 artifact schemas，运行定向测试和 typecheck。
- [ ] Commit：`feat(e2e): report actual approval assurance`

### Task 9：Skill、用户文档、迁移和 0.2.0 版本闭包

**Files:**
- Modify: `packages/skills/skills/testing/e2e/SKILL.md`
- Modify: `packages/skills/skills/testing/e2e/execution-approval.md`
- Modify: `packages/skills/skills/testing/e2e/browser-execution.md`
- Modify: `packages/skills/skills/testing/e2e/report-verdict.md`
- Modify: `packages/skills/skills/testing/e2e/skill.manifest.json`
- Modify: `packages/skills/test/e2e-skill.test.ts`
- Modify: `packages/e2e-runtime/src/runtime-state-migration.ts`
- Modify: `packages/e2e-runtime/test/runtime-state-migration.test.ts`
- Modify: `README.md`
- Modify: `CHANGELOG.md`
- Modify: seven E2E `package.json` files and `package-lock.json`

- [ ] 写失败测试：Skill 默认流程没有 identity enroll；confirmation-required 必须停等明确确认；旧 Run→webauthn、旧 browser→managed selection；包版本和内部依赖全为 0.2.0。
- [ ] 运行定向测试，确认 RED。
- [ ] 实现中文 Skill/文档、迁移和版本闭包。
- [ ] 运行定向测试、package topology 和 typecheck。
- [ ] Commit：`docs(e2e): publish the 0.2 local-first workflow`

### Task 10：Golden、安全矩阵与发布闭包验证

**Files:**
- Modify: `scripts/e2e-runtime-cross-repo-child.mjs`
- Modify: `scripts/e2e-runtime-cross-repo.golden.test.ts`
- Modify: `scripts/e2e-runtime-security-matrix.ts`
- Modify: `scripts/e2e-runtime-security-matrix.test.ts`
- Modify: `scripts/e2e-complete-report.golden.test.ts`

- [ ] 增加失败 Golden：空白项目使用系统 Chrome且不安装 managed Chromium；写入未确认不启动 Action；确认后执行/cleanup；报告保证等级准确。
- [ ] 运行对应 Golden，确认 RED；真实系统 Chrome 不可用时只登记显式外部门禁。
- [ ] 完成 fixtures 与生产装配，运行 Golden GREEN。
- [ ] 运行 `npm run build`、`npm run typecheck`、`npm run lint:architecture`、`npm test -- --reporter=dot`、`npm run e2e:golden`。
- [ ] 运行 `npm pack --dry-run --workspaces` 和 release closure 测试；不得 publish。
- [ ] 使用 `code-review` 与 `superpowers:verification-before-completion` 审查并修复所有发现。
- [ ] Commit：`test(e2e): verify local-first cross-repo acceptance`
