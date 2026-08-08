# E2E Runtime 渐进式架构优化 V2：分阶段实施计划

> 状态：Phase 0 已实施；支持宿主 Golden 待 CI/真实宿主完成
> 依据：`docs/superpowers/specs/2026-08-08-e2e-runtime-progressive-architecture-v2-audit.md`
> 行为兼容基线：`v0.5.2`
> 核心规则：每一阶段独立验证、独立提交、可回滚；不跨阶段预先实现。

## 1. 实施总则

1. 当前 `RuntimeRunSnapshot`、E2E Engine 和 Runtime Host 是事实权威。
2. 新 API 优先做 additive change；旧字段和旧入口不原地改语义。
3. 所有派生模型必须能从现有权威事实确定性重建。
4. 已创建 Run 固定到精确 Runtime 安装摘要，不随 default/current 指针升级。
5. 未知写入结果先 reconcile，不自动重试。
6. 在线自动更新启用前，必须先完成签名和回滚安全 ADR。
7. `submit-candidate` 在语义覆盖证明完成前继续保留。
8. 不在本计划内创建通用 `VerificationCase`。

## 2. Phase 0：表征基线与最小兼容边界

这是用户批准后唯一可以立即执行的阶段。

### 2.1 目标

- 把 `v0.5.2` 的真实公开行为固化为可执行契约。
- 解决当前全量测试的 secret-broker 并发/清理抖动。
- 增加一个只读 `RuntimeCompatibilityDescriptorV1`，为后续 Executor 和 Resolver 提供稳定边界。
- 不改变 Run、制品、审批、执行和报告语义。

### 2.2 预期文件范围

可能新增或调整：

- `packages/e2e-contracts/src/runtime-compatibility.ts`
- `packages/e2e-contracts/src/index.ts`
- `packages/e2e-contracts/test/runtime-compatibility.test.ts`
- `packages/e2e-runtime/src/runtime-compatibility.ts`
- `packages/e2e-runtime/src/index.ts`
- `packages/e2e-runtime/test/runtime-compatibility.test.ts`
- `packages/e2e-runtime/test/secret-broker.test.ts`
- `packages/cli/src/**` 与对应测试（仅在确认只读命令不会破坏 CLI 兼容时）
- `docs/adr/0011-runtime-compatibility-descriptor.md`

实际改动前先定位真实文件名；不得因为计划路径不同而创建重复入口。

### 2.3 Descriptor 内容

只描述已经存在且可以证明的事实：

- Runtime implementation version；
- protocol major/minor；
- accepted snapshot versions；
- artifact schema-set digest；
- declarative PRD design versions；
- executor capability names；
- Node/platform requirements；
- installation digest（已安装环境）；
- active-run exact binding rule。

Descriptor 不负责版本选择，不联网，不更新 current 指针。

### 2.4 表征测试

至少覆盖：

1. 友好 CLI 的参数、退出码和错误分类；
2. 严格 RPC envelope 的合法/非法输入；
3. `status/review/retry/report` 的现有语义；
4. Runtime snapshot 1.1–1.8 的可迁移与 fail-closed 条件；
5. Run installation digest mismatch 的拒绝行为；
6. Compiler 稳定 Case/Action/Oracle ID；
7. `submit-candidate` 在新旧链路中的现有职责；
8. Evidence→checkpoint→verdict→report 引用闭包；
9. 本地确认与 Gateway 动作授权；
10. 浏览器执行结果和 cleanup/reconcile 状态。

### 2.5 语义比较

以固定 fixture 同时运行调整前基线和新边界，比较归一化后的：

- response category/code；
- workflow state、stage、condition、next edge；
- stable IDs；
- artifact type/digest/ref graph；
- checkpoint expected/actual/status；
- verdict；
- report machine-readable summary。

时间戳、临时路径、端口和随机 request ID 只允许通过显式 normalizer 排除。

### 2.6 验证门禁

- `npm run typecheck`
- `npm run lint:architecture`
- `npm test` 至少连续两次全绿
- Phase 0 新增契约测试全绿
- 支持宿主上 `npm run e2e:golden` 全绿
- 工作区 pack Golden 全绿

### 2.7 回滚

删除新增只读 descriptor/inspector 和对应导出即可；Runtime 数据、安装布局和公开旧命令均未迁移。secret-broker 测试修复若涉及产品代码，必须单独提交，以便独立回滚。

### 2.8 停止条件

Phase 0 完成后停止，提交差异、测试证据、语义比较结果和下一阶段建议，不自动进入 Phase 1。

### 2.9 2026-08-08 实施结果

- 新增严格 `RuntimeCompatibilityDescriptorV1Schema` 和只读 `describeRuntimeCompatibility`。
- Descriptor 与 `RUNTIME_PACKAGE_VERSION`、`RuntimeStateMigrationRegistry`、current pointer、正式 Artifact Schema Set pointer 和 RPC major 完成语义比较。
- Snapshot `1.0.0` 被明确标记为只允许 `created` workflow 迁移，没有夸大兼容范围。
- `automaticUpgrade` 固定为 `false`；没有加入网络、版本选择、current pointer 修改或活跃 Run 迁移。
- 既有 CLI、RPC、Workflow、Run Store、Executor、Policy、Evidence、Verdict 和 Report 均未改动。
- `npm run typecheck`、`npm run lint:architecture` 通过。
- 新增契约测试 8/8 通过。
- `npm test` 在变更后连续两次通过：206 个测试文件通过、1 个条件跳过；1817 个测试通过、31 个宿主条件跳过。
- `secret-broker.test.ts` 定向 22/22 通过；全新隔离区基线和两次变更后全量测试均未复现原抖动，因此没有修改产品超时或清理语义。
- Package 验证已完成 TypeScript build 和 14 个 workspace tarball 构建；完整 pack Golden 未取得最终通过结论。
- 宿主证明：process、filesystem、system Chrome 和 disposable profile 已执行；当前受限沙箱 loopback 不可用，Gateway canary 未执行，不能把本地结果记为真实 Golden 全绿。
- 新增 `.github/workflows/e2e-golden.yml`：PR 到 `master` 或手动触发时，在无发布权限的 `macos-14` runner 执行 `verify:e2e-pack`；它不持有 OIDC、不发布 npm，也不运行 Registry Golden。
- Phase 1 未开始。下一步只能是在这个非发布型 macOS CI/支持宿主完成 pack Golden，再决定是否批准 Phase 1。

## 3. Phase 1：Task State 只读投影与恢复语义收敛

### 3.1 目标

- 用 `TaskStateViewV1` 统一展示 Workflow、Run condition、Case attempts、制品有效性和最小缺失输入。
- 不引入第二个持久化状态文件或状态机。
- 把恢复动作明确分类为 retry、resume、reconcile、new-run。

### 3.2 关键设计

`TaskStateViewV1` 必须由 `RuntimeRunSnapshot` 和 Artifact Store 确定性生成。任何 Facade/CLI/UI 只能读取这个投影，不得独立写入阶段或业务状态。

恢复分类：

- `retry`：确定未产生外部副作用的可重试步骤；
- `resume`：已有 checkpoint 且执行身份一致；
- `reconcile`：写操作结果未知，先观察真实外部状态；
- `new-run`：Source、Target 或安装绑定发生不可兼容变化；
- `migration-required`：旧 snapshot 缺少安全继续所需事实。

### 3.3 兼容和回滚

原 `RuntimeStatusResult` 继续保留；新 view 先作为可选投影并进行双写对比，但只有旧状态权威存在，不产生第二份持久化数据。回滚时移除投影，不迁移数据库。

### 3.4 实施记录（2026-08-08）

- 已新增严格 `TaskStateViewV1` Schema，统一 Workflow、Stage/Condition、Case Attempt、Artifact validity、最小缺失输入与 recovery 分类。
- 普通 `get-status` 响应保持不变；只有请求显式设置 `includeTaskState: true` 时才附加投影，旧严格客户端不会被未协商字段破坏。
- `E2EFacade.taskState(handle)` 已作为公开只读入口，并继续复验完整 RunHandle。
- retry 只允许无业务副作用的 Target Probe / Preflight；running/cleanup Case 和 effect-unknown 写一律 reconcile；缺少 Case attemptId 的旧快照一律 migration-required。
- `new-run` 已进入 Schema，但当前 Runtime 不从不充分事实猜测。未来 Resolver/Ingress 只有在形成 Source、Target 或 installation 不兼容的可信事实后才能输出该分类。
- 没有新增持久文件、状态迁移或第二状态机；架构决策见 `docs/adr/0012-task-state-read-only-projection.md`。
- 变更后 `npm run build`、`npm run typecheck`、`npm run lint:architecture` 通过；`npm test` 连续两次全绿：209 个测试文件通过、1 个条件跳过，1829 个测试通过、31 个宿主条件跳过。

## 4. Phase 2：Browser Executor 协议化

### 4.1 目标

在现有 capability-branded executor 外增加 `BrowserExecutorProtocolV1`，统一：

- capability discovery；
- execute/result schema；
- progress；
- timeout/cancellation；
- evidence refs；
- effect/cleanup/reconcile；
- retry safety。

### 4.2 实施顺序

1. 为现有 Read/Write/Injection/Full Playwright/Preflight/Probe 能力建立 descriptor。
2. 写 adapter，把现有输出投影为新结果，保持 WeakMap brand。
3. 选择一个只读 Case 做双路径执行和语义比较。
4. 再接入一个受 Gateway 保护的写 Case，验证未知结果进入 reconcile。
5. 全量 Case 切换完成前保留旧调用路径和特性开关。

### 4.3 回滚

关闭 adapter 路由即可恢复旧 capability 调用；不得同时修改 Case Schema 或 Verdict 语义。

## 5. Phase 3：Assertion 语义显式化

### 5.1 目标

新增 `AssertionResultV1` 只读投影，让 Report、外部消费方和未来 Executor 使用统一语言，但不复制事实。

### 5.2 映射

```text
OracleCheckpointResult
  expected   → Assertion.expected
  actual     → Assertion.actual
  status     → Assertion.status
  evidence   → Assertion.evidenceRefs
  oracleId   → Assertion.oracleId
```

Assertion 不允许独立写入；Verdict 继续由 Engine 基于 checkpoint/coverage/policy 计算。Report 只消费 Verdict 和投影，不自行重新判断 pass/fail。

### 5.3 回滚

移除投影消费者即可；历史制品无迁移。

### 5.4 实施记录（2026-08-08）

- 新增严格 `AssertionResultV1Schema` 和 `projectAssertionResultV1`，逐字段投影 `OracleCheckpointResult`。
- Final Report Step 保留 checkpoint，并附加确定性 `assertionResults`；Schema 会拒绝两者任何漂移。
- Markdown 与 HTML Case 详情展示统一 Assertion 语义，JSON 报告保留机器可读投影。
- 没有新增 Assertion Artifact、状态文件、写入入口或 Verdict 计算路径。
- 架构决策见 `docs/adr/0014-assertion-result-read-only-projection.md`。

## 6. Phase 4：Policy 投影统一

### 6.1 目标

把已有计划级 approval grants 和 Gateway 动作级 enforcement 显式映射为统一的 `PolicyDecisionViewV1`，消除重复风险分类，但保留两个执行时点。

### 6.2 必须保留

- 用户确认的 source/scope/acceptance/execution approval；
- subject、run、target、action、payload 绑定；
- lease、expiry、cleanup 权限；
- Gateway 对真实写请求的二次校验；
- signed receipt/audit log；
- 默认本地确认和可选 WebAuthn。

### 6.3 禁止

- 用“用户已经批准整个 E2E”绕过具体写动作校验；
- 让浏览器测试代码直接访问宿主文件、SSH key 或未授权环境变量；
- 让写请求绕过 Gateway；
- 自动修复未知外部副作用。

### 6.4 实施记录（2026-08-08）

- 新增严格 `PolicyDecisionViewV1`，把 Authority freshness receipt 逐 Capability 投影为计划级批准，把 Gateway signed request event 投影为动作级执行。
- 统一展示 subject、run bundle、target、Action、Capability、payload、lease、cleanup、Policy 与证据绑定；不复制 Policy 状态或风险分类器。
- Final Report JSON/Markdown/HTML 使用同一策略决策表，并明确区分“计划级批准”和“动作级执行”。
- Engine 独立事实审计会重算完整集合，拒绝调用方即使重算 `decisionId` 后的伪造绑定。
- 整体批准仍不能绕过 Gateway；Gateway 事件不臆造其权威契约中不存在的阻断原因。
- 架构决策见 `docs/adr/0015-policy-decision-view-preserves-enforcement-stages.md`。

## 7. Phase 5：Runtime Resolver（本地与 pinned）

### 7.1 目标

先在不联网的情况下验证版本选择模型：

- `offline`：只使用本地兼容版本；
- `pinned`：选择用户指定的精确版本/摘要；
- 已有 Run：始终选择其 installation digest；
- 新 Run：按策略选择并固化摘要。

### 7.2 实施边界

复用现有版本目录、manifest 校验、锁、原子安装和 launcher。Resolver 不重写 installer。垃圾回收必须识别活跃 Run 引用，禁止删除其 Runtime closure。

### 7.3 回滚

关闭 Resolver 选择，恢复 current pointer 的现有精确版本；现有 Run 不受影响。

### 7.4 实施记录（2026-08-08）

- 新增纯本地 `RuntimeResolverPolicy`，Phase 5 只接受 `offline` 与精确 `pinned`；`stable`、`latest`、SemVer range 和隐式安装全部 fail-closed。
- `offline` 完整验证 current closure；`pinned` 完整验证指定版本及可选 installation digest；两者都不移动 current pointer。
- 已有 Run 忽略新 Run 策略，只按其原始 installation digest 定位已安装 closure；缺失、篡改或摘要歧义均阻断恢复。
- 新增 `withResolvedRuntimeInstallation`，要求调用方在同一安装锁回调内持久化 Run 绑定，关闭“选择完成、绑定尚未固化”之间的卸载竞态。
- Run Store 提供活跃 installation 引用投影；卸载器在同一安装锁内检查引用，拒绝删除任何非终态 Run 仍绑定的 closure。
- 固定 launcher 和 installer 没有重写，现有 current 默认行为保持兼容；在线 stable/LKG 仍受 Phase 6 人工 ADR 门禁约束。
- 架构决策见 `docs/adr/0016-local-runtime-resolution-and-run-binding.md`。

## 8. Phase 6：Runtime Resolver（签名 stable 与 LKG）

### 8.1 前置 ADR

先批准 Runtime 更新信任 ADR，覆盖：

- pinned root key；
- manifest schema/version；
- key rotation；
- rollback protection；
- emergency revocation；
- cache expiry/offline grace；
- npm provenance 与更新清单的职责边界；
- Node runtime compatibility；
- telemetry/audit data 最小化。

### 8.2 stable 流程

只对新 Run：获取并验签 stable 清单 → 下载/验证 → 原子安装 → health check → 创建 canary new Run → 成功后更新 new-run default → 失败回退 LKG。

`latest` 必须保持显式 opt-in，不能与 stable 同批默认启用。

### 8.3 回滚

current/new-run-default 指针原子回退到 LKG；失败版本保留诊断但不再被自动选择。活跃 Run 继续使用各自绑定版本。

## 9. Phase 7：生产模块大规模 p95 Benchmark

该阶段必须有独立 Benchmark Spec，不能直接沿用现有合成脚本的结论。

### 9.1 固定规模

- 500 Requirement
- 2000 Rule
- 5000 obligation
- 1000 Case

### 9.2 必须测量的正式模块

- PRDRunCompiler；
- requirement/rule/oracle graph；
- coverage audit；
- Case schedule；
- Evidence/checkpoint finalization；
- Engine Verdict；
- HTML/JSON Report；
- Artifact publication。

### 9.3 证明要求

固定硬件/runner、Node 版本、warmup、样本数、fixture digest、单项 p50/p95/p99、峰值内存、产物大小、失败率。CI 只在具有稳定资源的 runner 上作为 gate；普通 PR runner 可做趋势告警。

### 9.4 实施记录（2026-08-08）

- 新增 v2 生产 Benchmark proof 与八阶段独立 worker，旧 `verify:e2e-scale` 继续保留为合成快速回归，不再承担生产 p95 结论。
- 固定构造 500 Requirement / 2000 Rule / 5000 obligation / 1000 Case，并真实调用 PRDRunCompiler、Requirement graph schema、Coverage、Case Scheduler、Assertion 与 production finalization material、Verdict、完整报告和 Artifact Store。
- 每阶段独立进程执行 3 warmup + 20 正式样本，报告 nearest-rank p50/p95/p99、max、绝对峰值 RSS、输出分布和失败率。
- 本机 Apple M1 Pro / Node v24.18.0 趋势证明八阶段零失败且预算全通过；因非登记稳定 runner，proof 明确标记 `gateEligible=false`。
- 新增只支持人工触发的专用 self-hosted stable runner workflow；在该 runner 注册前不加入普通 PR required checks。
- Benchmark Spec 与结果分别见 `docs/superpowers/specs/2026-08-08-e2e-production-performance-benchmark.md`、`docs/benchmarks/e2e-production-performance-2026-08-08.json`。

## 10. Phase 8：未来非浏览器 Executor 决策门

只有出现真实第二类执行器、并完成 Browser-to-Browser 基准后才评估通用 `VerificationTask`。

需要证明：

1. 迁移至少 90% 的 Browser Case 不改变业务语义；
2. 未迁移部分有明确浏览器专属原因；
3. Evidence/Assertion/Verdict/Policy 可以复用；
4. 引入抽象后的复杂度低于复制执行引擎；
5. Browser E2E 的交互、Popup、多页、下载、Trace 等能力没有降级。

未满足这些条件时保持浏览器领域模型，不创建通用 `VerificationCase`。

### 10.1 独立审计记录（2026-08-08）

- 仓库生产执行路径全部属于浏览器领域；Target Probe、Preflight、Read、Reversible Write、Injection 和 Full Playwright 是同一 Executor 的能力/品牌，不构成真实第二类 Executor。
- Evidence、Assertion、Verdict、Policy 等下游边界具备复用基础，但没有第二执行器、迁移 corpus、复杂度对比或抽象候选 Golden，不能据此推导通用 Case。
- 决策门六项仅“下游边界可复用”部分满足，其余均缺少可验证证据，因此保持 `DeclarativeCase` / `CompiledCase` / `BrowserExecutorProtocolV1`，不新增 `VerificationCase`、通用注册表或持久 schema。
- ADR 0018 固化重开条件：真实第二 Executor、≥90% 无语义变化迁移、例外清单、字段级复用、复杂度净降低，以及覆盖表单、Popup、多页面、下载、Trace、JSON 写、Cleanup、Reload 的 Browser-to-Browser 对照 Golden。
- Phase 8 是架构审计，不改变 Runtime 行为、历史 Run 或 Artifact；满足证据前只允许无生产导出、无 schema 承诺的 prototype。

## 11. 全局发布与验证门禁

每阶段至少执行：

1. `npm run typecheck`
2. `npm run lint:architecture`
3. `npm test`
4. 受影响包的 contract/characterization tests
5. 支持宿主的 `npm run e2e:golden`
6. `npm run verify:e2e-pack`
7. 发布候选 Registry Golden（仅发布阶段）
8. Git diff、包内容、版本和 Skill Runtime pin 一致性检查

版本发布必须保持所有 E2E 包、Skill manifest、文档示例、安装器和 tag 的版本真相一致。

## 12. 每阶段交付格式

每个阶段完成时必须提供：

- 改动职责和未改动职责；
- 文件清单；
- 兼容性比较结果；
- 测试和 Golden 证据；
- 已知限制；
- 回滚命令/开关；
- 是否满足进入下一阶段的门禁；
- 下一阶段建议，但不自动跨越审批门禁。
