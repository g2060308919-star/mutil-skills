# E2E Runtime 渐进式架构优化 V2：阶段 A 架构审计与审批结论

> 状态：阶段 A 已批准；阶段 B Phase 0 已实施，等待支持宿主 Golden
> 审计日期：2026-08-08
> 代码基线：`master` / `4aa5df16959339a1705e915ca722d7be291fb3e6` / `v0.5.2`
> 输入：用户提供的《mutil-skills E2E Runtime 渐进式架构优化 Spec（V2）》全文
> 本文约束：只记录审计、修正规格和实施边界，不修改 Runtime 核心行为。

## 1. 审批结论

结论：**有条件批准，修正后可以实施；不能把输入 Spec 原样直接翻译成代码。**

输入 Spec 的总体方向是正确的：

1. 坚持 PRD 驱动的浏览器 E2E，不退化为通用任务引擎。
2. 先建立兼容基线和表征测试，再调整边界。
3. 保持 `Evidence → Assertion → Verdict → Report` 单向事实链。
4. 区分任务状态、制品状态和业务裁决。
5. 保留计划级授权与动作级 Gateway 授权两层控制。
6. Runtime Resolver 采用渐进式启用，而不是直接切换到在线自动更新。
7. 不在缺少真实需求时提前引入通用 `VerificationCase`。
8. 每个阶段都要求可回滚、可对比、无静默语义漂移。

但是，Spec 对当前仓库的部分判断来自抽象目标模型，而非当前 `v0.5.2` 实现。若原样实施，会造成重复状态机、重复断言事实、破坏活跃 Run 的安装绑定，或者错误删除仍位于正式主链路上的兼容入口。因此，阶段 B 必须以本文的修正版本为实施依据。

## 2. 当前真实架构与主链路

### 2.1 当前系统事实源

当前正式系统已经包含以下有效模块：

| 职责 | 当前事实源 |
| --- | --- |
| 协议和 Schema | `packages/e2e-contracts` |
| 确定性工作流、裁决、制品事务 | `packages/e2e-engine` |
| RPC 编排、Run 生命周期、恢复 | `packages/e2e-runtime` |
| 浏览器执行 | `packages/e2e-playwright-runtime` |
| 网络动作授权与转发 | `packages/e2e-gateway` |
| 本地确认与可选 WebAuthn | `packages/e2e-authority` |
| HTML/JSON 报告 | `packages/e2e-report` |
| 用户入口 | `packages/cli` 与 `packages/skills/skills/testing/e2e` |

`E2ERuntimeHost` 是当前 RPC 和流程编排权威；`RuntimeRunStore` 使用 SQLite 快照、日志、锁和 fencing token 保存 Run；`E2EEngine` 负责确定性状态迁移、裁决和制品提交；浏览器执行由原生 Playwright / Playwright Test 实现，通过受约束能力对象注入 Runtime。

### 2.2 当前正式主链路

```text
Requirements Contract
  → create-run / source-frozen
  → prepare-prd-understanding
  → compile-prd-run
  → TargetContract / TargetProbe
  → submit-candidate 兼容制品入口
  → Scope / Lineage 审批
  → 语义模型与覆盖义务
  → AcceptanceReview 用户确认
  → Discovery / Preflight / Binding
  → Execution Approval
  → 多 Case 调度与 Playwright 执行
  → Gateway 动作授权
  → Screenshot / Trace / HTTP 等证据
  → OracleCheckpointResult
  → Engine Verdict
  → 原子化制品发布
  → Standalone HTML / JSON Report
```

这条链路已经能够覆盖系统 Chrome、隔离 Profile、正式 RPC、完整 Playwright API、Popup、多页面、写请求、Cleanup、Reload 验证、截图和 Trace。

### 2.3 当前公开入口

面向用户的友好 CLI 包括：

- `prepare-input`
- `status --run`
- `review --run`
- `confirm-review --run --digest`
- `retry --run`
- `report --run`（兼容 `--run-id`）
- `install-runtime` / `uninstall-runtime`
- `configure-browser --system`
- `configure-approval`
- `install-browser`
- `secret ...`
- `identity enroll` / `identity approve`
- `doctor [--json]`
- `rpc`

严格 RPC 协议版本为 `1.0.0`，请求和响应使用 Zod 判别联合校验。当前包含 20 个左右的流程命令，公开状态响应同时携带 workflow state、stage、condition、next edge、verified digests、minimum missing input、target probe、acceptance review、semantic cases 和 preserved/invalidated assets。

## 3. 有效实现、兼容链路与仅设计能力

### 3.1 已生效、不得重复建设

| 能力 | 当前状态 | 阶段 B 处理原则 |
| --- | --- | --- |
| Workflow State Machine | 已生效 | 深化投影，不创建第二套状态机 |
| Run 持久化与恢复 | 已生效 | 延续 SQLite + journal + locking，不改成简单 JSON 状态文件 |
| PRDRunCompiler | 已生效 | 补兼容表征，不重写编译器 |
| 稳定 Case/Action/Oracle ID | 已生效 | 作为兼容基线 |
| 多 Case 调度、Attempt、Cleanup | 已生效 | 统一执行端口和结果语义 |
| `E2EFacade` | 已生效但覆盖不完整 | 扩展既有 Facade，不新建平行 Facade |
| TargetContract / TargetProbe | 已生效 | 继续作为目标身份事实源 |
| AcceptanceReview | 已生效 | 保持用户可见的 PRD→Requirement→Rule→Oracle 确认 |
| Playwright 执行能力 | 已生效 | 在现有 capability 边界外增加版本化协议，不替换实现 |
| 计划级授权 + Gateway 动作授权 | 已生效 | 合并重复投影，不重新设计授权系统 |
| Evidence Capture / Quarantine | 已生效 | 保持内容寻址与证据引用 |
| Oracle Checkpoint | 已生效 | 作为 Assertion 的权威语义来源 |
| Verdict / Report 分离 | 已生效 | 保持单向链路 |
| 原子安装、锁、恢复、完整性校验 | 已生效 | Resolver 在其上选择版本，不另造安装器 |

### 3.2 遗留但仍在正式链路中

以下能力不能仅因名称或文档描述为“旧”而删除：

1. `submit-candidate`：虽然 Skill 将其描述为旧 Run 兼容入口，但当前新 Run 在多个状态仍通过它提交 27 类低层制品。它是**兼容链路且仍是主链路的一部分**。
2. `.biztest` Project Publisher：Standalone workspace 已是主输出，但仓库内发布仍是有效可选适配器。
3. Declarative PRD Design `1.0.0`：`2.0.0` 已存在，但旧 Schema 仍处于读取/迁移兼容范围。
4. WebAuthn：默认本地确认已满足日常流程，WebAuthn 仍是显式增强模式，不能作为默认必需，也不应移除。
5. Managed Chromium：系统 Chrome 是默认路径，受控 Chromium 仍是兼容和 CI 备选路径。

### 3.3 尚未实现或仅存在于设计层

1. 通用 `VerificationTask` / `VerificationCase` 领域模型。
2. 可发现版本和 capabilities 的统一 `ExecutorAdapter` 协议。
3. `stable/latest/pinned/offline` Runtime Resolver。
4. 签名更新清单、根密钥轮换、回滚保护、撤销/kill switch。
5. Last Known Good 自动回退与新 Run 灰度启用。
6. 独立的通用 Assertion 制品类型；当前有相同语义，但位于 `OracleCheckpointResult`。
7. 使用生产模块完成的 500/2000/5000/1000 p95 证明。
8. Browser-to-Browser 迁移基准和 90% 迁移阈值证明。

其中第 1 项不应在本轮创建；第 6 项只能做确定性投影或类型别名，不能建立第二份事实。

## 4. 输入 Spec 与代码事实冲突

### 4.1 兼容基线不是 0.5.0

当前发布、Skill、包版本和 Git tag 的一致基线是 `0.5.2`。`0.5.1` 和 `0.5.2` 修复了输入准备、目标探测、报告证据链接等正式路径问题。将 `0.5.0` 固化为兼容基线会重新引入已经修复的错误行为。

修正：阶段 B 的行为兼容基线固定为 `v0.5.2`。

### 4.2 活跃 Run 不能随 current 指针自动升级

当前 Run 保存 `runtimeInstallationDigest`，Runtime 会拒绝使用不同安装摘要继续执行该 Run。这个约束防止同一个 Run 在执行中途被另一份代码解释。

修正：

- 新 Run 可以通过 Resolver 选择兼容的 stable/latest/pinned 版本。
- 已创建 Run 在完整生命周期内固定到原始 Runtime 版本和安装摘要。
- 自动更新只能改变“新 Run 的默认选择”，不能切换活跃 Run。
- 跨 Runtime 恢复必须是显式迁移，重新校验 Schema、制品、Policy 和审批；没有迁移证明时必须拒绝。

### 4.3 `submit-candidate` 不是纯遗留命令

当前状态路由在 `created/source-frozen/scope-approved/modeled/preflight/binding/execution-approved` 等阶段仍会返回 `submit-candidate`。高层 `compile-prd-run` 尚未生成完整的低层候选制品集合。

修正：先把它正式定义为 Candidate Ingress 兼容边界；后续由 Compiler/Facade 逐类接管制品投影。只有当语义等价测试证明新链路完整覆盖后，才能弃用公开入口。

### 4.4 不创建第二份 Assertion 事实

当前 `OracleCheckpointPlan/Result` 已记录 expected、actual、status 和 evidence refs，其语义就是断言结果。

修正：若调用方需要统一名称，新增 `AssertionResultV1` 确定性投影；权威数据仍来自 checkpoint，不引入可独立写入的 Assertion store/artifact。

### 4.5 不创建第二套任务状态

当前系统已经同时区分：

- Workflow state：确定性流程位置；
- Run stage / condition：用户可理解的阶段与可恢复状态；
- Case/attempt status：调度与执行结果；
- Artifact state：preserved / invalidated / verified；
- Verdict：业务裁决。

修正：目标 `TaskState` 是上述权威状态的只读投影，不是新持久化状态机。禁止引入可与 `RuntimeRunSnapshot` 独立变化的 `task-state.json`。

### 4.6 Executor 边界不是空白

当前已有 Read、Write、Injection、Full Playwright、Preflight、Target Probe 等带 capability brand 的注入边界。它们能阻止未经授权的任意对象伪装成执行器，但缺少版本发现、标准化取消/超时/进度和统一结果协议。

修正：新 `BrowserExecutorProtocolV1` 包装现有 capabilities；保留 WeakMap brand 和安全注入机制，不做一次性替换。

### 4.7 Resolver 需要独立信任设计

npm OIDC provenance、registry integrity 和包哈希能证明发布来源与包完整性，但不能直接充当具有版本选择、撤销、回滚保护语义的更新清单。

修正：在线 Resolver 启用前必须先形成签名 ADR，至少覆盖：固定根信任、清单签名、密钥轮换、版本单调性、回滚授权、撤销/kill switch、缓存过期、离线行为和审计记录。

### 4.8 Launcher 的 Node 路径属于兼容边界

当前稳定 launcher 会验证安装清单和 current 指针，但安装时会捕获 Node 可执行文件的绝对路径。Node 被移动或卸载时，即使 Runtime 文件完整也可能无法启动。

修正：Resolver/Bootstrap 设计必须校验 Node 运行时约束，并提供明确诊断；不得把这类失败报告为业务 E2E 失败。

### 4.9 当前大规模性能证明不是生产链路证明

现有 `verify:e2e-scale` 能稳定生成 500 Requirement / 2000 Rule / 5000 obligation / 1000 Case 数据并计算 p95，但核心测量使用合成数组、过滤、摘要和 HTML 操作，不是对正式 PRDRunCompiler、Artifact Graph、Verdict 和 Report 模块的端到端调用。

修正：保留它作为微基准/测试装置性能证明；另建 Benchmark Spec，用正式模块和固定 fixture 生成生产级 p95 结论。

## 5. 兼容基线与支持窗口

### 5.1 固定基线

阶段 B 首个里程碑必须保持以下 `v0.5.2` 行为不变：

1. 现有友好 CLI 参数、退出码和错误分类。
2. RPC `1.0.0` 的既有请求/响应语义。
3. 现有 27 类制品名称、内容摘要和引用关系。
4. Stable Case/Action/Oracle ID。
5. Workflow state、stage、condition、next edge 和 recovery 语义。
6. 默认系统 Chrome、本地确认、Gateway 强制写操作路径。
7. 证据、checkpoint、verdict 和 report 的现有事实链。
8. Runtime 原子安装与 Run 安装摘要绑定。

### 5.2 可证明的兼容范围

- Runtime protocol：当前只承诺 major `1` 中已发布字段的向后兼容；新增字段必须是可选或通过新命令暴露。
- Snapshot：`1.1.0` 至 `1.7.0` 可迁移到当前 `1.8.0`；`1.0.0` 只允许迁移 `created` 状态。缺少必要事实时继续 fail closed，并返回 `migration-required`。
- Artifact Schema：以 `e2e-contracts/schemas/sets` 的内容寻址集合和 current pointer 为准。
- 执行：Run 创建后固定到精确 Runtime 安装摘要；不承诺任意旧 Runtime 二进制可以执行新 Run。
- 读取/报告：仅按显式 snapshot/schema 兼容表承诺，不用“最近 N 个版本”替代证据。

### 5.3 弃用规则

在 `0.x` 阶段：

1. 已公开命令或 Schema 的移除必须至少提前一个 minor 版本声明，并保留不少于 60 天。
2. 安全漏洞可立即禁用危险执行能力，但必须保留可读取状态、导出证据和生成阻断报告的路径。
3. `submit-candidate` 只有在所有正式制品具备新入口、语义对比全绿、真实 Golden 全绿后才进入弃用期。
4. 活跃 Run 使用的 Runtime 安装不得由普通更新或垃圾回收删除。

## 6. Current → Target 职责映射

| 目标概念 | 当前承载 | 目标调整 |
| --- | --- | --- |
| Verification Task | `RuntimeRunSnapshot` + status projection | 仅增加只读 `TaskStateView`，不新增存储权威 |
| Browser Case | PRD compiler semantic cases + schedule | 保持领域模型，补执行协议版本 |
| Executor Adapter | 多个 capability-branded executor | 增加统一 descriptor/result/cancel/progress 层 |
| Assertion | `OracleCheckpointResult` | 增加确定性 `AssertionResultV1` 投影 |
| Verdict | `E2EEngine` verdict | 保持唯一裁决权威 |
| Report | `e2e-report` | 消费投影，不自行推断业务结论 |
| Policy | plan grants + Gateway enforcement | 统一风险/授权投影，保留两次执行点检查 |
| Runtime Resolver | installer + versions/current launcher | 分阶段增加选择器、签名清单、LKG；活跃 Run 固定摘要 |
| Facade | 现有 `E2EFacade` | 增加兼容事实与渐进式高级编排，不新建平行入口 |

## 7. 已发现基线问题

### 7.1 全量测试存在并发/清理抖动

`npm test` 本次结果：203 个测试文件通过、1 个失败、1 个跳过；1809 个测试通过、1 个失败、31 个跳过。失败发生在 `secret-broker.test.ts`：全量并发环境下首个用例超过 5 秒，临时 HOME 清理随后遇到 `ENOTEMPTY`。该文件单独运行 22/22 全绿。

分类：测试隔离与清理抖动，不是需要保留的产品兼容行为。阶段 B 必须先稳定该基线，不能把偶发红灯当成架构改造回归。

### 7.2 当前沙箱不能作为真实 Golden 宿主

本次 `npm run e2e:golden` 受到宿主权限阻断：loopback `listen EPERM`，Chrome 启动被 macOS Mach port 权限拒绝。此结果只证明当前受限执行环境不具备 Golden 所需宿主能力，不能证明产品逻辑失败。

正式 Golden 必须在已支持的 macOS CI/真实宿主运行；报告要明确区分 `environment-blocked`、`not-executed` 和业务 `failed`。

### 7.3 宿主能力证明

`verify:e2e-host` 中 process、filesystem、browser、profile 已执行；当前沙箱 loopback 不支持，Gateway canary 未执行。阶段 B 的宿主矩阵必须在真实 macOS/Linux runner 上补齐 loopback 和 Gateway canary，受限沙箱结果不能替代。

## 8. 修正后的目标架构

### 8.1 单一权威原则

```text
RuntimeRunSnapshot（唯一流程/恢复权威）
  ├─ TaskStateView（只读投影）
  ├─ BrowserCaseSchedule（执行投影）
  ├─ ArtifactValidityView（制品投影）
  └─ RuntimeStatusResult（用户状态投影）

Evidence
  → OracleCheckpointResult
  → AssertionResultV1（可选、确定性投影）
  → Engine Verdict（唯一裁决）
  → Report（只呈现，不重裁决）
```

任何投影都不能独立写回并改变权威事实。

### 8.2 Executor 原则

`BrowserExecutorProtocolV1` 是现有 Playwright capability 的协议外壳，而非替代实现。它至少描述：

- protocol version；
- capabilities；
- input/output schema versions；
- timeout/cancellation；
- progress events；
- evidence references；
- write effect 与 cleanup/reconcile 状态；
- retry safety。

发生未知写入结果时不得自动重试，必须先 reconcile。

### 8.3 Resolver 原则

```text
Bootstrap
  → 读取用户策略（offline / pinned / stable / latest）
  → 若是已有 Run：按 installation digest 定位原 Runtime
  → 若是新 Run：解析兼容版本
  → 验签清单与包完整性
  → 原子安装到版本目录
  → 健康检查
  → 仅更新“新 Run 默认版本”指针
  → 失败回退 LKG
```

第一阶段只支持本地已安装版本和 pinned 选择；在线 stable、latest 必须后续分开启用。

## 9. 阶段 A 验证记录

| 检查 | 结果 | 说明 |
| --- | --- | --- |
| `npm run typecheck` | 通过 | 当前 TypeScript 基线有效 |
| `npm run lint:architecture` | 通过 | 当前包边界无静态违规 |
| `npm test` | 审计环境曾出现一次抖动 | 原工作区曾有 1 个全量并发失败；Phase 0 全新隔离区基线全绿 |
| `npm run verify:e2e-scale` | 通过但结论受限 | 合成微基准，不是生产链路 p95 |
| `npm run verify:e2e-host` | 部分宿主能力通过 | 受限沙箱不支持 loopback/Gateway canary |
| `npm run e2e:golden` | 环境阻断 | 不作为产品回归结论 |
| Git 工作区基线 | 干净 | 审计开始时 `master...origin/master` |

## 10. 阶段 B 准入门禁

用户已明确批准本文与配套实施计划。首个阶段 B 里程碑严格限制为：

1. 修复或隔离已知测试基线抖动；
2. 为 `v0.5.2` 公开命令、Schema、状态、恢复、证据链建立表征/契约测试；
3. 增加一个最小、只读、无状态迁移的兼容边界；
4. 对调整前后输出做语义比较；
5. 不删除旧入口、不迁移活跃 Run、不启用在线自动更新；
6. 全部可运行验证通过后停止并汇报，再决定下一阶段。

配套实施步骤、文件范围、风险和回滚方式见：`docs/superpowers/plans/2026-08-08-e2e-runtime-progressive-architecture-v2.md`。
