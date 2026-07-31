# E2E Runtime 深化设计

## 状态

已批准，2026-07-31。

## 背景

E2E Runtime 0.4.5 已完成从 requirements contract、系统 Chrome、正式 RPC、Gateway、full-playwright、Cleanup、Reload 到 JSON/Markdown/HTML 报告的 Chromium 单 Case Golden。当前剩余的能力瓶颈不是浏览器动作覆盖，而是：

1. Skill 仍需沿 Runtime 状态机逐项组装低层 Artifact；
2. 正式 full-playwright 投影只接受单 Case、单 Program、单 scheduled actor；
3. 浏览器已产生截图和 Trace 事实，但生产 finalization 没有把它们发布为可直接查看的独立证据包；
4. Spec 中的大规模性能和宿主能力承诺缺少完整、机器可读的证明；
5. `CONTEXT.md` 与 ADR 没有记录已经形成的 E2E 领域模型和关键架构决定。

## 目标

- Runtime 提供从已确认 requirements contract 到完整候选 Artifact 图的高层确定性编译 interface。
- Runtime 在一个 Generation 内执行并恢复多个相互独立的 Case。
- E2E 可以完全脱离 Git 和业务代码仓库运行。
- 每个 Run 生成独立、可移动、可校验的截图、Trace、Artifact 和报告目录。
- 使用固定大规模 fixture 生成 p50/p95、内存和预算证明。
- 使用宿主能力证明区分业务失败、Runtime 失败和宿主能力缺失。
- 建立 E2E 当前领域真相和决策记录。

## 非目标

- 不在本轮引入并行 Case 调度；第一版使用确定性串行队列。
- 不在本轮实现像素基线视觉回归。
- 不在本轮自动上传 Git、CI Artifact 或对象存储。
- 不在本轮增加 Firefox/WebKit adapter。
- 不让 Runtime 使用模型重新理解自然语言 PRD。
- 不改变生产环境不可逆写操作永久拒绝的安全原则。

## 总体架构

```text
requirements contract + source bundle + frozen policies
  → PRDRunCompiler
  → sealed candidate Artifact graph
  → semantic/scope/execution review
  → MultiCaseScheduler
  → ControlledBrowserHost + Gateway + Authority
  → EvidenceBundlePublisher
  → standalone Run Workspace
  → deterministic Final Report
```

Skill 只负责：

- 调用一次 `understand-prd` 或内置等价流程；
- 展示 Runtime 返回的语义、范围和执行审批内容；
- 获取调用者确认；
- 调用高层 Runtime RPC；
- 交付报告目录。

Skill 不再拥有 Artifact 顺序、摘要计算、状态转换、多 Case cursor、覆盖率或 verdict。

## PRDRunCompiler

### 输入

新增高层命令 `compile-prd-run`，输入严格包含：

```ts
interface CompilePrdRunInput {
  requirementsContract: string
  sources: readonly PrdSourceInput[]
  projectPolicy: ProjectPolicyInput
  environment: ExecutionEnvironmentInput
  scopeDecisions: readonly ScopeDecisionInput[]
  outputRoot?: string
}
```

`requirementsContract` 必须是已由调用者确认且 route 指向 `e2e` 的唯一契约原文。Compiler 不调用模型，不重新总结 PRD，只从契约节点、验收条件、来源和显式策略确定性投影。

### 输出

Compiler 在 Runtime 内创建并密封：

- PRD request、manifest、diff 和 source bundle；
- acceptance scope；
- requirement model、rule、oracle 和 interaction flow；
- coverage universe、obligation disposition 和 design audit；
- test cases、action intents、execution contract；
- regression manifest 和 execution review。

输出只暴露：

- `runId`
- `assetId`
- `compilerDigest`
- `review`
- `unresolvedItems`
- `nextRequiredDecision`

调用者不能覆盖 Runtime 生成的 ID、摘要、引用或状态。

### 歧义

缺少验收条件、来源冲突、无法确定 expected 或 scope decision 不完整时，Compiler 返回 `requirements-blocked` 和严格 `unresolvedItems`。不得猜测、弱化 Oracle 或自动排除 Clause。

### 兼容

现有低层 `submit-candidate` RPC 暂时保留，标记为兼容 interface。E2E Skill 默认只使用高层命令。旧 Run 快照继续读取。

## MultiCaseScheduler

### Case 状态

每个 scheduled Case 独立持久化：

```text
pending → preflight → ready → running → cleanup
  → passed | failed | unable | safety-blocked
```

`CaseExecutionRecord` 至少绑定：

- runId、caseId、actorId、queueOrdinal；
- actionIds、attemptId、attempt chain；
- approval/grant、capability 和 lease 引用；
- Browser Context/session；
- Gateway audit 和 outcome receipt；
- evidence IDs；
- cleanup 状态；
- terminal verdict。

### 调度

- 第一版严格按冻结 `queueOrdinal` 串行执行。
- 每个 Case 可以包含多个 Action 和 Oracle checkpoint。
- 每个 Case 第一版绑定一个 actor；不同 Case 可以绑定不同 actor。
- 每个 Case 使用独立 Browser Context；需要写入或 Cleanup 时使用对应 lease 和 capability。
- Case 结果不能被聚合 Case 状态掩盖。

### 失败与恢复

- 纯读且明确未发生副作用的失败可按 retry policy 创建新 attempt。
- `effect-unknown` 永不自动重试。
- Cleanup 未完成时，恢复优先完成 Cleanup。
- 已 terminal 的 Case 不重新执行。
- Runtime 在每个 Case 状态边和 terminal 后原子持久化 scheduler cursor。
- `resume-run` 从 cursor 继续，不接受调用者自报已完成 Case。
- 后续 Case 是否继续由冻结 failure policy 决定。

### 最终化

只有所有 required Case 都具有合法 terminal、所有写 Case 均有 Cleanup 结论、所有 required Oracle 均有结果和证据时，Run 才能 finalization。`BrowserResults.executedBrowserIds` 必须来自真实执行集合，不能从计划矩阵第一项推断。

## 独立 Evidence Bundle

### 输出根

显式 `outputRoot` 优先。未提供时使用：

```text
~/.mutil-skills/e2e/reports/<asset-id>/<run-id>/
```

输出与 Git、源码仓库和当前工作目录无关。

### 目录

```text
<run-id>/
  evidence/<case-id>/
    <checkpoint-id>.png
    playwright-trace.zip
    dom.html
    evidence-index.json
  artifacts/
  final-report.json
  final-report.md
  final-report.html
  manifest.json
```

### 原始截图决定

原始截图不执行 OCR、遮罩、像素脱敏或内容修改。Runtime 必须：

- 证明截图来自本次受控 Browser session；
- 绑定 Case、Action、Checkpoint、Oracle 和 Attempt；
- 校验媒体格式、文件大小和 bytes digest；
- 拒绝 symlink、hardlink 和越出 outputRoot 的路径；
- 默认使用 `0700` 目录和 `0600` 文件；
- 在 manifest 中记录相对路径、摘要和字节长度；
- 在离线 HTML 报告中直接显示。

### Trace

Trace 保存在本地 Run Workspace，绑定来源、摘要和 Case。Trace 不自动上传或提交 Git。报告提供本地文件入口。Secret 仍不得由 Skill 或测试源码直接读取；Gateway/Runtime 已掌握的认证材料不得额外复制到 manifest。

### 发布 adapter

Git、CI Artifact、对象存储和项目内 `.biztest` 都是可选 publisher adapter，不是执行、finalization 或 accepted verdict 的前提。

## 大规模性能证明

新增确定性 `ScaleFixtureBuilder`，构造：

- 500 Requirement；
- 2000 Rule；
- 5000 obligation；
- 1000 Case；
- 完整 lineage、结果和 evidence metadata。

`verify:e2e-scale` 在固定输入上至少连续运行 10 次，分别测量：

- compile；
- graph audit；
- coverage；
- schedule build；
- finalization；
- verdict recomputation；
- JSON/Markdown/HTML render；
- workspace publication。

机器结果包含：

```ts
interface PerformanceProof {
  schemaVersion: '1.0.0'
  fixtureDigest: string
  environment: {
    platform: string
    arch: string
    node: string
    cpuCount: number
    totalMemoryBytes: number
  }
  phases: Record<string, {
    samples: number
    p50Ms: number
    p95Ms: number
    maxMs: number
    peakRssBytes: number
    budgetMs: number
    budgetPassed: boolean
  }>
  proofDigest: string
}
```

百分位算法固定并测试。证明写入用户指定路径或临时验证目录，不依赖终端文本。

## 宿主能力集成矩阵

新增 `HostCapabilityProbe`，生成 `HostCapabilityProof`：

- loopback bind/connect；
- child process spawn/terminate/PID identity；
- POSIX mode、owner、symlink、hardlink、inode；
- atomic rename/fsync；
- system Chrome 或 managed Chromium；
- disposable Profile；
- Gateway direct-bypass canary。

测试分层：

- Policy tests：所有环境必须执行，禁止条件 skip。
- Host adapter tests：环境声明支持某 capability 后必须真实执行，任何 skip 都失败。
- Unsupported-host tests：验证 Doctor 返回稳定 reasonCode、category 和 remediation。

`verify:e2e-host --require=<capabilities>` 对显式要求但未执行的 capability 失败。

## CONTEXT 与 ADR

`CONTEXT.md` 增加：

- requirements contract、source bundle、requirement、rule、oracle、obligation；
- Case、Action、Attempt、Checkpoint；
- Runtime Host、Engine、Authority、Gateway、Browser Runtime；
- Evidence Bundle、Artifact Generation、Final Report；
- 每个 module 的决定权和禁止复制的逻辑。

新增 ADR：

1. Runtime Host 是唯一工作流权威；
2. requirements contract 确定性编译为 Artifact graph；
3. 多 Case 独立 attempt、cleanup 和恢复；
4. 独立 Run Workspace 与原始截图策略；
5. Host Capability Proof 和集成测试矩阵。

## 安全不变量

- 测试源码不能读取环境变量、SSH key 或任意宿主文件。
- 所有目标流量仍强制经过 Gateway。
- 写操作仍需 Authority capability、Data Lease、reservation 和 outcome receipt。
- 原始截图不脱敏是显式产品决定，不允许据此放宽 Trace、DOM、日志或 secret 的访问边界。
- outputRoot 只允许 Runtime 创建的正规目录树，拒绝符号链接、硬链接和目录穿越。
- Report 不计算 verdict。
- Skill 不计算摘要、覆盖、审批有效性或状态。

## 迁移

- 旧单 Case execution contract 映射为长度为 1 的 Case 队列。
- 旧 browser results 映射为一个 CaseExecutionRecord。
- 快照 schema 使用显式版本迁移，不原地猜测未知字段。
- 现有低层 RPC 在一个兼容周期内保留。

## 测试策略

- 所有生产行为先写失败测试并验证 RED。
- Compiler：确定性、歧义阻塞、来源绑定、调用者不可覆盖。
- Scheduler：三 Case 顺序、不同 actor、失败继续/停止、effect-unknown、Cleanup 恢复、崩溃恢复。
- Evidence：原始 screenshot bytes 不变、Trace 可打开、digest、防路径攻击、独立 outputRoot、HTML 引用。
- Performance：fixture 数量、百分位算法、proof digest、预算失败。
- Host：probe、require 语义、支持环境零跳过、unsupported reasonCode。
- Migration：旧单 Case快照读写和恢复。
- Golden：全新 HOME、安装包、系统 Chrome、正式 RPC、至少三个 Case、写入、Cleanup、Reload、截图、Trace 和完整报告。

## 完成定义

- E2E Skill 不再需要逐项组装低层 Artifact。
- 单个 Run 至少三个独立 Case，各自具有 terminal、Evidence 和 verdict。
- 中间 Case 失败不丢失已完成结果。
- 写 Case 的 Cleanup 和 Reload 可复算。
- Runtime 崩溃不会重复已完成写操作。
- 默认和显式 outputRoot 都能脱离 Git 工作。
- HTML 报告直接显示原始截图并提供 Trace。
- 大规模 performance proof 可重复生成并满足预算。
- 声明支持的宿主 capability 测试零跳过。
- CONTEXT 和 ADR 与实现一致。
- 类型检查、架构检查、全量测试、Workspace Golden 和 Registry Golden 全绿。
