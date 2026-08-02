# E2E 全流程可靠性与可恢复性设计

## 状态

Approved。本文固化 2026-08-02 已由用户确认的 E2E 优化方案。

## 背景

用户在另一台电脑上使用同版本 `mutil-skills v0.4.5` 与 `E2E Runtime 0.4.5`，以本地 PRD 和可由受控 Chrome 访问的 localhost 网站执行真实 E2E。流程在浏览器预检阶段被阻断，并暴露安装恢复、版本身份、调用接口、环境绑定、页面身份、流程恢复、Run 隔离、过程可视化、Fixture、执行模式、报告语义、来源角色和需求确认共十八类问题。

0.4.6 已新增 PRDRunCompiler、多 Case 调度、原始截图与 Trace；0.4.7 已加强 Registry 和 pack 内容一致性。这些能力不解决本设计聚焦的流程可靠性、可恢复性和用户可见性问题。

## 目标

1. 用户只需提供 PRD 和目标地址，即可由 E2E Skill 驱动完整流程，不需要理解底层 Runtime JSON envelope。
2. 在任何真实浏览器 Case 执行前，用户能看到并确认唯一的 PRD 理解、验收范围、交互流程、覆盖和语义 Case。
3. localhost 等目标的可达性只以正式受控浏览器与 Gateway 所在网络上下文为准，不以 agent shell 网络作为业务阻断依据。
4. 页面身份可通过受限的声明式策略配置，并在审批前由无副作用 Target Probe 提前验证。
5. 可修复的预检失败不终结 Run；修复后在同一 Run 重试，只失效实际受影响的下游资产。
6. 安装、版本、Run、Fixture、执行模式、结果和证据均有稳定、可解释、可追踪的契约。
7. 保留 Runtime Host、Authority、Gateway、隔离 Profile、可信 Compiler、证据闭包和 Engine Verdict 的现有安全强度。

## 非目标

1. 不开放任意 JavaScript、`page.evaluate`、任意 Node/Playwright 源码或 shell 执行。
2. 不允许浏览器绕过 Gateway 直连目标。
3. 不把本地确认描述为已验证自然人身份或职责分离。
4. 不让 preview、injection 或 mock 结果冒充真实链路结果。
5. 不让恢复机制自动重试 effect unknown 的写操作。
6. 不要求业务仓库接入后端、Git、CI Artifact 或对象存储。

## 不可退化的不变量

- Runtime Host 继续作为唯一 RPC、工作流和恢复权威。
- 外部输入继续在 Runtime 边界接受严格 Schema 校验；高层接口只隐藏协议复杂度，不放宽协议。
- Authority 继续独占审批、能力、租约、reservation 和签名结果事实。
- Gateway 继续独占目标出站、请求计数、注入和副作用事实。
- Browser Runtime 继续使用系统 Chrome 或显式托管 Chromium、一次性 Profile 和受控 session。
- AI/Skill 只提交声明式需求、Case、Action、Oracle、定位候选、Fixture 和 Cleanup 意图。
- Playwright 源码继续由受信 Projector 和 Compiler 生成。
- 页面、Binding、Fixture、网络、写操作或 Cleanup 主题变化时，旧执行批准必须失效。
- effect unknown 永不自动创建新 Attempt。
- Screenshot、Trace、DOM、Gateway audit、Outcome 和 Verdict 继续绑定同一 Run、Generation、Case、Action 和 Attempt。

## 总体流程

```text
Version Closure / Doctor
→ Source Freeze
→ Understand PRD exactly once
→ Target Contract
→ Untrusted Read-only Target Probe
→ Requirement / Rule / Oracle / Flow
→ PRDRunCompiler semantic Case plan
→ Acceptance Review + local confirmation receipt
→ Execution Subject Review + local approval
→ Trusted Preflight / Binding
→ Trusted Playwright Compile
→ MultiCaseScheduler
→ Browser / Gateway / Cleanup / Reload
→ Evidence / Verdict / Report
```

Target Probe 是非权威、无副作用的早期诊断；Trusted Preflight 仍在执行批准后运行，并为正式执行提供可信环境事实。两者不能共用证据身份，也不能把 Probe 结果投影成执行通过。

## 深模块与公开接口

### E2E Facade

Skill 面向一个高层接口，Facade 在 Runtime 内部生成严格 requestId、协议 envelope、状态跟随调用和错误投影：

```ts
interface E2EFacade {
  start(input: StartE2ERunInput): Promise<RunProjection>
  review(handle: RunHandle): Promise<AcceptanceReview>
  confirmReview(input: ConfirmAcceptanceReviewInput): Promise<RunProjection>
  approveExecution(input: ConfirmExecutionSubjectInput): Promise<RunProjection>
  execute(handle: RunHandle): Promise<RunProjection>
  retry(handle: RunHandle): Promise<RunProjection>
  status(handle: RunHandle): Promise<RunProjection>
  report(handle: RunHandle, outputRoot?: string): Promise<RenderedRunReport>
}
```

CLI 提供同语义命令：

```text
repo-e2e run --prd <path-or-url> --target <url>
repo-e2e status --run <run-handle> [--open]
repo-e2e retry --run <run-handle>
repo-e2e report --run <run-handle> [--open]
```

低层 `repo-e2e rpc` 继续存在，作为稳定机器协议和兼容接口。Facade 错误必须同时包含中文可操作信息与原始 `reasonCode`、`requestId`、`runId`、失败字段路径和 remediation，不得吞掉诊断事实。

### RunHandle

```ts
interface RunHandle {
  assetId: string
  runId: string
  revision: number
  generationDigest: string
}
```

所有会推进或读取 Run 的高层操作使用完整 RunHandle。Runtime 拒绝 assetId、runId、revision 或 generationDigest 不闭合的请求。每个 Standalone Run Workspace 只对应一个 RunHandle；旧 requestId 或旧 generation 不得写入活动 Run。

### TargetContract 与 EnvironmentContract

调用者只提交目标 URL、可选页面身份策略和环境标签。Runtime 规范化 scheme、origin、path，并生成唯一环境身份：

```ts
interface TargetContract {
  schemaVersion: '1.0.0'
  targetUrl: string
  baseOrigin: string
  environmentLabel: string
  pageIdentityPolicy: PageIdentityPolicy
  allowedNavigationOrigins: string[]
}
```

Policy、Run、Discovery、Preflight 和 Execution 只引用同一 TargetContract digest，不再让调用者重复提供环境 ID。缺少 scheme 的 `localhost:3000` 可以规范化为 `http://localhost:3000`；全角标点或非法 URL 返回字段级中文错误，不静默猜测不同 origin。

### PageIdentityPolicy

```ts
type PageIdentitySignal =
  | { kind: 'test-id'; value: string }
  | { kind: 'role'; role: string; name: string }
  | { kind: 'css-visible'; selector: string }
  | { kind: 'visible-text'; value: string; exact: boolean }
  | { kind: 'title'; value: string; exact: boolean }
  | { kind: 'heading'; value: string; exact: boolean }

interface PageIdentityPolicy {
  url: { origin: string; pathPattern: string }
  signals: PageIdentitySignal[]
  match: { mode: 'all' } | { mode: 'at-least'; count: number }
}
```

最低身份强度为 URL origin/path 加至少一个业务信号。`visible-text` 不能单独成为页面身份。selector 仅允许受限 CSS 语法，禁止脚本、XPath、伪元素、跨 origin frame 和任意 evaluate；信号数量、文本长度、selector 长度和总执行时间均有固定上限。

未显式配置时，Target Probe 从 URL、`data-testid`、landmark、稳定标题和可见文本提出候选，Skill 展示候选，Runtime 使用保守默认策略。候选不是可信执行事实。

### Target Probe

Target Probe 使用与正式执行相同的 Chrome 选择、一次性 Profile 和 Gateway 路径，但只持有内置、单次、显式 origin 的只读能力：

- 只允许 GET/HEAD、静态导航、DOM/ARIA 读取和非发布截图。
- 不执行 Case、点击、键盘、表单提交、写请求、下载、Popup 或跨 origin 导航。
- 只用于可达性、页面身份候选和错误诊断。
- shell/agent sandbox 对 localhost 的访问失败不能覆盖 Probe 的浏览器结果。
- Probe 产物标记为 `untrusted-diagnostic`，不能进入 Verdict 或冒充 Trusted Preflight evidence。

### AcceptanceReview

`understand-prd` 或内置等价流程仍只执行一次。Runtime 从冻结来源、唯一 requirements contract 和 PRDRunCompiler 输出生成不可由 Skill 改写的 AcceptanceReview：

```text
PRD 原文与 SourceSpan
→ Clause disposition
→ Requirement
→ Rule
→ Oracle
→ Interaction Flow
→ Coverage obligation
→ Semantic Case
→ Included / Excluded / Ambiguous
```

Skill 必须在 Trusted Preflight 前逐项展示，用户以本地确认方式确认 `reviewDigest`。Authority 签发 `local-confirmation` 回执，但固定报告 `identityVerified=false`、`separationOfDutiesVerified=false`。调用者布尔值或 `confirmed-by-caller` 不能替代该回执。

Execution Approval 不重复完整 PRD，只展示与实际执行有关的 Target、页面身份、Binding、Action、请求、副作用、Fixture、DataLease 和 Cleanup 差异。

### Semantic Case 与 Executable Case

PRDRunCompiler 在 Probe 后、Trusted Preflight 前生成完整 Semantic Case。每个 Case 具有：

- Requirements、Rules、Oracles 和 obligations 映射；
- 声明式 Action；
- PageIdentityPolicy 和 locator candidates；
- FixtureContract；
- ExecutionLane；
- `bindingStatus = pending | ready | blocked`；
- 阻断 reasonCode 和最小缺失项。

用户始终可以查看 Semantic Case。只有 Trusted Preflight 通过且 locator binding、审批主题和 Source Set 重新闭合后，可信 Compiler 才生成 Executable Case。预检失败不能生成伪 Playwright 文件或 skip Case。

### FixtureContract 与 ExecutionLane

```ts
type ExecutionLane =
  | 'preview-readonly'
  | 'real-reversible-write'
  | 'injection-simulated'

interface FixtureContract {
  actorRef: string
  preconditions: FixturePrecondition[]
  seedStrategy: 'pre-existing' | 'gateway-api' | 'browser-ui' | 'injection'
  dataLease?: DataLeaseIntent
  cleanup?: CleanupIntent
  reloadVerification?: OracleIntent[]
}
```

每个 Oracle 声明允许的 lane。Preview 不能证明服务端持久化；Injection 不能证明真实依赖；真实写必须有 DataLease、Cleanup 和 Reload oracle。Injection fixture 不能装入真实链路 session。

## 可恢复状态模型

现有单枚举把流程阶段、阻断原因和终态混合在一起。新快照分离：

```ts
type RunStage =
  | 'requirements'
  | 'target-probe'
  | 'planning'
  | 'acceptance-review'
  | 'execution-approval'
  | 'preflight'
  | 'compiled'
  | 'execution'
  | 'finalization'
  | 'completed'

type RunCondition =
  | { kind: 'ready' }
  | { kind: 'awaiting-user'; decisionId: string }
  | { kind: 'running'; attemptId: string }
  | { kind: 'blocked-retryable'; reasonCode: string; resumeStage: RunStage }
  | { kind: 'blocked-requires-change'; reasonCode: string; resumeStage: RunStage }
  | { kind: 'terminal'; verdict: 'accepted' | 'rejected' | 'incomplete' }
```

安全阻断、Artifact 篡改、版本不兼容仍不可原地忽略；Runtime 可以要求新 generation 或 migration。可达性、页面身份、系统 Chrome 暂不可用等环境问题通常为 `blocked-retryable`。

### 失效矩阵

| 变化 | 保留 | 失效 |
| --- | --- | --- |
| 同 URL 服务重启 | PRD、Review、Scope、Semantic Case、审批主题摘要 | Probe、Preflight 测量 |
| PageIdentityPolicy 变化 | PRD、Requirement、Rule、Oracle、Semantic Case | Probe、Binding、Execution Approval、Preflight、Executable Case |
| Fixture、请求或 Cleanup 变化 | PRD、需求模型、覆盖 | Execution Approval、Executable Case、执行结果 |
| target origin 或环境变化 | PRD、需求模型 | TargetContract 下游全部资产 |
| PRD 原文或依赖来源变化 | Source history | 新 requirements revision；全部派生资产重建 |

`retry` 只能重新执行当前 blocker 对应的验证。任何已开始且 effect unknown 的写 Attempt 进入 Recovery Coordinator，不得由通用 retry 创建新 Attempt。

## 安装与版本身份

Runtime 安装使用内容寻址目录和事务日志：

```text
downloaded → unpacked → verified → activated → committed
```

安装到临时目录，验证 Registry integrity、稳定文件内容摘要、可执行语义和 Runtime manifest 后，原子切换 current pointer。恢复规则：

- 同版本、同 Registry integrity、同稳定内容摘要：成功幂等返回。
- 已证明 owner 死亡且未提交：回滚临时目录并继续。
- owner 存活或所有权无法证明：阻断并报告 owner/phase。
- 同版本但稳定内容不同：`VERSION_CONTENT_CONFLICT`，禁止覆盖。
- current pointer 与已验证目录不一致：只在唯一可证明候选存在时自动修复，否则阻断。

`doctor --json` 为每个失败返回 `reasonCode`、`category`、`recoverability`、`expected`、`actual`、`preservedState` 和精确 remediation。发布 tgz 封装 metadata 不参与稳定内容身份；普通权限归一化但可执行位保留语义。

## 状态投影与可视化

Runtime 在 Standalone Run Workspace 原子更新：

```text
run-status.json
run-status.md
run-status.html
```

投影包含 RunHandle、当前 stage/condition、requirements review、范围、覆盖、Semantic/Executable Case、审批、Target Probe、Preflight、Fixture、执行进度、blocker、证据和可操作 remediation。静态 HTML 无 CDN、无后端、默认目录权限仅当前用户可读写。原始 PRD、DOM、截图和 Trace 不自动提交 Git 或上传网络。

## 结果与报告语义

报告分离四个维度：

1. `progress`：planned/running/completed；
2. `executionStatus`：passed/failed/not-executed/blocked；
3. `blocker`：input/environment/policy/safety/automation/artifact；
4. `verdict`：accepted/rejected/incomplete。

环境阻断不是业务失败；未执行不是通过；只有 Oracle 实际值不满足预期才是业务失败。被阻断的 Run 可以生成 Interim Report，但只有 Engine Finalization 生成 Final Report。

## 来源角色

Source Bundle 每项必须声明且只声明一种角色：

- `requirements-source`：可以生成 Clause；
- `target-application`：执行目标和观察来源，不能生成 PRD Clause；
- `supporting-reference`：只能支撑已存在节点，不自动进入验收范围；
- `fixture-source`：只描述测试数据准备或清理。

Runtime 拒绝把 target 页面、辅助文章、聊天文本或 Fixture 自动提升为 requirements source。报告分别列出四类来源。

## 兼容与迁移

- 低层 RPC 保持兼容；新高层 Facade 使用新增协议命令和 Snapshot schema。
- 0.4.5/0.4.7 旧 Run 不伪造 AcceptanceReview、TargetContract 或可恢复 blocker。旧 Run 只读渲染，或显式迁移到新 generation。
- 新 Skill 与 Runtime 必须精确版本闭包；不匹配时在 create-run 前阻断，并给出精确安装命令。
- 迁移失败不得删除旧 Run Workspace。

## 验收标准

1. 全新 HOME 安装成功；同版本连续安装两次均成功且 current identity 不变。
2. 安装每个 kill point 均可在 owner 已死时安全恢复；owner 存活和不确定状态继续阻断。
3. Skill/Runtime 不匹配在创建 Run 前被准确阻断。
4. shell 无法访问 localhost、受控 Chrome 可以访问时，Target Probe 和正式 E2E 可以继续。
5. 没有 `h1/h2/h3` 的页面可以通过 test-id、ARIA、受限 CSS 或可见文本组合识别。
6. 过宽页面策略、脚本 selector、单独常见文本和跨 origin selector 被拒绝。
7. 页面身份失败后，同一 Run 修改策略、重新批准差异并重试成功。
8. 服务重启后同一 Run 重试，Requirement、Rule、Oracle、Coverage 和 Semantic Case ID 保持不变。
9. 用户在 Trusted Preflight 前看到并确认 PRD 原文到 Semantic Case 的完整链路。
10. 未取得 AcceptanceReview receipt 时 Runtime 拒绝进入执行批准和 Preflight。
11. Preflight 失败时完整 Semantic Case 可见，Executable Case 不被伪造。
12. 真实写 Case 具备 Fixture、DataLease、Cleanup、Reload 和真实 Oracle；Injection 结果不能计为真实通过。
13. 报告准确区分 environment-blocked、not-executed、business-failed、accepted。
14. 两个并存 Run 不能混用 requestId、revision、generation、脚本、审批或证据。
15. JSON、Markdown、HTML 状态投影事实一致，HTML 无网络依赖且默认私有。
16. 现有 Gateway、Authority、隔离 Profile、可信 Compiler、证据闭包、effect unknown 不重试的安全测试继续通过。

## 实施边界

本设计必须同时修改 Contracts、Engine、Runtime Host、Installer、Browser Adapter、Report、CLI 和 E2E Skill。只修改 Skill 文案、只升级包版本或在 Engine 状态机上增加无条件回边均不构成完成。
