# mutil-skills 领域与架构术语表

本文档描述一个围绕 schema 驱动内容、可复用 template、skill、CLI 入口和业务中立 core 构建的 monorepo 架构词汇。

## 术语

**Package**：
monorepo 内位于顶层 workspace 的模块，拥有自己的源码、测试和依赖边界。
_避免使用_：folder、directory、module

**Schema**：
定义仓库内内容和配置所用结构契约、类型与校验规则的 package。
_避免使用_：model、config shape

**Template**：
拥有可复用模板资产，并负责从结构化输入渲染模板的 package。
_避免使用_：scaffold、preset

**Skill**：
以结构化 skill 内容和支撑代码打包的仓库能力，受仓库约定约束，并可被工具发现。
_避免使用_：script、snippet

**Skill Manifest**：
机器可读的 `skill.manifest.json` 文件，用于记录仓库特定的 skill metadata、requirements 和 orchestration hints，同时保持复制来的 skill 内容稳定。
_避免使用_：embedded enhancement text、modified upstream skill body

**Standalone Agent Skill Package**：
可分发的 skill 目录，例如 `skills/engineering/tdd`。它可以不依赖仓库 CLI 单独安装，因此必须在 `SKILL.md` 中包含足够的人类可读 preflight 指令，让接入方 agent 或 host runtime 能安全执行必要 setup。
_避免使用_：CLI-only skill、manifest-only runtime package

**Manifest Schema**：
由 schema package 拥有的契约，用于在 CLI workflow 解释 `skill.manifest.json` 前定义并校验其形状。
_避免使用_：untyped manifest、CLI-only manifest parsing

**Template Reference**：
skill 或配置中保存的声明式标识符，用来命名应使用哪个 template，而不直接导入或执行 template 代码。
_避免使用_：template dependency、render hook

**Testing Foundation**：
测试驱动 workflow 运行前所需的最低项目级测试基础设施，包括测试 scripts、runner 选择、runner 默认环境和测试文件放置约定。
_避免使用_：optional test setup、ad hoc testing

**Foundation Package**：
可外部安装的 `foundation` package，提供可复用工程基础能力，第一项能力是测试基础设施。
_避免使用_：base、common package、hidden CLI internals

**Foundation Runner**：
foundation package 导出的可复用执行表面，例如测试运行或默认 runner 配置；它不拥有面向用户的 workflow prompt。
_避免使用_：CLI command、interactive setup flow

**Testing Domain**：
foundation package 暴露的第一个 public API domain，仅聚焦测试基建能力。
_避免使用_：generic foundation API、all-purpose infrastructure API

**Foundation Template**：
template package 拥有的可复用模板，用于生成 example tests、script fragments 或显式请求的测试基建文件。
_避免使用_：CLI-owned config、skill-owned test files

**Foundation Orchestration**：
CLI 拥有的流程：检测测试就绪状态、展示缺失的 foundation、请求 bootstrap 确认，并应用安装或生成步骤。
_避免使用_：skill installer、template executor

**Foundation Detection**：
CLI 在决定 TDD 是否可以运行或是否需要 bootstrap 前，对 scripts、dependencies 和 test structure 做的三级测试就绪检查。
_避免使用_：test script check、runner check

**Vitest Baseline**：
当项目没有现有测试基建时，由 CLI 确认后接入的默认测试基建。它安装 `@mutil-skills/foundation`、写入 scripts 和样例测试；默认 Vitest 环境由 foundation runner 提供，不在目标项目生成 `vitest.config.ts`。
_避免使用_：Jest default、generic test runner

**Runner Compatibility**：
CLI 保留现有测试 runner 选择（例如 Jest）并补齐缺失部分的规则，而不是迁移到默认 runner。
_避免使用_：forced migration、runner replacement

**Bootstrap Confirmation**：
检测到缺失测试基建后、应用项目修改前的显式用户确认步骤。
_避免使用_：silent setup、implicit install

**Script Integration**：
可选且需用户确认的接入方式，用于把消费项目的 package scripts 连接到仓库管理的命令，例如 test 或 TDD runner。
_避免使用_：mandatory script rewrite、hidden command install

**CLI**：
暴露命令行入口并编排其他 packages 的 package；它不拥有各领域规则。
_避免使用_：app、runtime

**Core**：
提供跨 package 技术原语的 package，必须保持不含 skill、template 或 schema 特定业务语义。
_避免使用_：common business logic、shared domain helpers

## E2E 领域

E2E 系统的权威数据流是：

```text
Requirements Contract
→ PRDRunCompiler
→ Artifact Graph
→ MultiCaseScheduler
→ Browser Runtime / Gateway / Authority
→ Evidence Bundle
→ Engine Verdict
→ Final Report
```

**Requirements Contract**：
调用者确认的唯一 PRD 语义契约，包含来源绑定节点、验收条件、依赖和 E2E route。Runtime 不重新总结或猜测该契约。
_避免使用_：PRD summary、second requirements model

**PRDRunCompiler**：
Runtime 内的确定性深模块。它把 Requirements Contract 和声明式 Case/Action/Oracle 设计编译为规范化 Run 计划，独占生成稳定 ID、摘要和绑定关系。它不调用模型，也不接受调用者提供的 Artifact digest、审批结果或 verdict。
_避免使用_：Skill artifact assembler、LLM compiler

**Declarative E2E Design**：
Skill 或模型可以提出的 Case、Action、Oracle、定位候选、网络意图和 Cleanup 意图。它只描述测试语义，不包含可信执行事实或宿主代码。
_避免使用_：generated Node program、caller-signed artifact

**Artifact Graph**：
同一 Generation 内 PRD、范围、需求、覆盖、Case、执行、证据和结果 Artifact 的封闭引用图。摘要、引用完整性和 schema 由 Runtime/Engine 复算。
_避免使用_：loose JSON files、Skill-owned state

**MultiCaseScheduler**：
Runtime 拥有的持久串行 Case 调度器。每个 Case 有独立 actor、attempt、Gateway/Lease 绑定、Evidence、Cleanup 和 terminal；已完成 Case 不因后续失败或恢复而重放。
_避免使用_：mega Case、for-loop in Skill

**Case Attempt**：
一个 Case 的单次受控执行身份。写操作的 effect 为 unknown 时，不得自动创建新 Attempt。
_避免使用_：retry counter only、replayed write

**Runtime Host**：
E2E 唯一 RPC、工作流和恢复权威。它协调 Contracts、Engine、Authority、Gateway、Browser Runtime、Artifact Store 和 Report；Skill 不复制其状态机。
_避免使用_：backend service、Skill runtime

**Runtime Resolver**：
只从受控 Runtime closure 中选择执行版本，并把精确 installation digest 固化到 Run。Phase 5 仅支持本地 `offline` 与精确 `pinned`；新 Run 必须在安装锁内完成选择和持久绑定，已有 Run 必须按原摘要恢复，活跃引用阻止卸载或 GC。
_避免使用_：SemVer range at execution、current means run identity、resolve then bind later

**Target Contract**：
一次 Run 唯一的目标环境契约，闭合目标 URL、base origin、环境标签、允许导航来源和页面身份策略。Policy、Probe、Discovery、Preflight 与 Execution 必须引用同一摘要，不能分别提交彼此矛盾的 environment ID。
_避免使用_：scattered baseUrl、caller environment flag

**Target Probe**：
在需求理解和 Case lane 编译之后、可信预检之前运行的非权威浏览器诊断。它使用系统 Chrome、一次性 Profile 和 Gateway，只在显式来源内发现有限的 GET/HEAD 精确资源闭包，并按执行 lane 与历史诊断选择 resource-closure、application-ready 或 dom-identity。长期连接、Console/pageerror、失败请求、DOM 是否存在和可见文本进入诊断快照；只有 preview-readonly 的资源类阻断可以升级策略，页面身份、pageerror 和含写 lane 均不得降级。结果不能进入 Verdict。
_避免使用_：curl health check、trusted preflight、business evidence

**Target Probe Diagnostics**：
一次 Probe attempt 的有界、可持久化诊断事实，包含策略、URL/title、DOM 是否存在、可见文本摘要、Console/pageerror、失败请求、真正未结束的请求、尚未获批的新 URL、长期连接、资源计数和 advisory。阻断状态通过 Run Status Workspace 自动呈现，且必须标记业务 Case 是否实际执行。
_避免使用_：generic timeout string、terminal business report

**Page Identity Policy**：
由 URL origin/path 与 test-id、ARIA role/name、受限 CSS、可见文本、标题或 heading 等业务信号组成的声明式页面身份。普通文本不能独自构成身份，策略不允许脚本、XPath、伪元素或任意 evaluate。
_避免使用_：heading-only heuristic、arbitrary selector script

**Acceptance Review**：
Runtime 从冻结来源和编译资产生成的不可改写验收视图，逐项展示 PRD 原文/SourceSpan、Clause 处置、Requirement、Rule、Oracle 和 Case。用户只确认其摘要一次；这不是第二次需求理解，也不能替代 Execution Approval。
_避免使用_：LLM summary confirmation、generic approval boolean

**Run Handle**：
由 assetId、runId、revision 和 generationDigest 组成的活动 Run 引用。页面身份、Fixture 或目标变化会推进 revision；旧 handle、旧 requestId、旧批准和旧脚本不能写入新 revision。
_避免使用_：bare runId、latest run guess

**Run Stage / Run Condition**：
Stage 表示流程位置，Condition 独立表示 ready、awaiting-user、running、blocked-retryable、blocked-requires-change 或 terminal。环境阻断不再伪装成业务失败，也不必为了重试复制完整 Run。
_避免使用_：single overloaded status enum、failed means everything

**Task State View**：
`RuntimeRunSnapshot` 与现有 Status 权威投影的确定性只读视图，统一展示 Workflow、Stage/Condition、Case Attempt、制品有效性、最小缺失输入和恢复分类。它不持久化、不接受独立写入，也不计算业务 Verdict；普通 `get-status` 保持兼容，只有显式 opt-in 或 Facade `taskState` 才返回 `TaskStateViewV1`。
_避免使用_：task-state.json、second workflow、UI-owned recovery state

**Semantic Case / Executable Case**：
Semantic Case 在可信预检前即可展示完整需求、Rule、Oracle、lane、Fixture 和 binding 状态；Executable Case 只有在身份、定位、审批和来源闭合后才由可信 Compiler 生成。阻断 Case 不能用 skip 或伪 Playwright 文件冒充执行。
_避免使用_：CASE id only、generated test before preflight

**Fixture Contract**：
Case 的声明式前置数据与恢复契约，包含 actor、precondition、seed strategy、DataLease、Cleanup 和 Reload oracle。真实写 lane 必须闭合 lease、cleanup 与 reload verification；注入 lane 不能声称验证真实依赖。
_避免使用_：ad hoc UID injection、implicit cleanup

**Authority**：
审批、能力、租约、reservation、结果回执和签名事实的权威边界。调用方布尔值不能替代 Authority 事实。
_避免使用_：approved flag、caller role claim

**Gateway**：
浏览器外的出站和副作用强制边界。所有目标请求按冻结 intent、capability 和次数匹配，页面或测试程序不能绕过它直连目标。
_避免使用_：page.route mock、optional proxy

**Browser Runtime**：
使用系统 Chrome 或显式托管 Chromium、一次性 Profile 和受控 Playwright session 执行已批准 Action 的模块。它不能读取日常浏览器 Profile。
_避免使用_：daily Chrome automation、arbitrary Playwright host

**Browser Executor Protocol**：
Runtime 内部位于现有品牌化执行器之外的统一适配协议。V1 为 Target Probe、Preflight、Read、Reversible Write、Injection 和 Full Playwright 提供同一能力描述、进度、dispatch 前 deadline/cancellation、结果、证据材料、cleanup、reconcile 与重试安全语义；适配器只闭合持有原 WeakMap capability，不公开原 backend，也不允许任意浏览器代码跨越可信边界。迁移期旧路径仍为默认，read shadow 只执行一次浏览器动作，再对旧结果与协议投影做 fail-closed 语义比较；写 effect 为 unknown 时只能 reconcile。
_避免使用_：second browser runtime、generic callback executor、retry unknown write

**Verification Abstraction Decision Gate**：
把 Browser Case/Executor 提升为通用 Verification 模型前必须通过的架构决策门。真实第二类生产 Executor、至少 90% Browser Case 无语义变化迁移、浏览器专属例外清单、下游契约复用、复杂度净降低和 Browser-to-Browser 全能力 Golden 缺一不可；Probe、Read、Write、Injection 与 Full Playwright 只是同一浏览器领域的能力，不算第二类 Executor。当前决策是保留浏览器领域模型。
_避免使用_：generic VerificationCase by anticipation、multiple browser modes mean multiple executors、rename-first abstraction

**Standalone Run Workspace**：
与 Git、业务仓库和当前工作目录解耦的单 Run 输出目录。默认位于 `~/.mutil-skills/e2e/reports/<asset-id>/<run-id>/`，也可以显式指定 `outputRoot`。
_避免使用_：mandatory .biztest、Git evidence directory

**Evidence Bundle**：
Standalone Run Workspace 中按 Case/Checkpoint 绑定的原始截图、原始 Trace、经策略处理的 DOM、manifest 和报告。原始截图保持浏览器 bytes 不变，但仍校验媒体、来源、路径、权限和摘要；DOM、console、network、storage 不因截图策略而绕过 quarantine、扫描与必要脱敏。
_避免使用_：untracked screenshot、report attachment without digest

**Host Capability Proof**：
对 loopback、进程、POSIX 文件系统、浏览器和一次性 Profile 等宿主能力的机器证明。声明 required 的能力必须真实执行，不能通过条件 skip 冒充通过。
_避免使用_：environment boolean、silent skip

**Verdict**：
Engine 根据冻结 Artifact 和实际执行事实复算的唯一终态。Report 只渲染，Skill 只转述。
_避免使用_：LLM conclusion、report-calculated status

**Assertion Result**：
`OracleCheckpointResult` 的 `AssertionResultV1` 确定性只读投影，逐字段展示 checkpoint、oracle、expected/actual 规范 JSON 与摘要、status 和 evidence refs。它不接受独立写入，不拥有存储，也不能改变 Verdict；Final Report 可以携带并展示该投影，但必须与同 Step 的 checkpoint 完全一致。
_避免使用_：assertion store、report-owned assertion、second verdict fact

**Policy Decision View**：
计划级 Authority freshness receipt 与动作级 Gateway enforcement event 的 `PolicyDecisionViewV1` 确定性只读投影。它统一 subject/run-bundle/target/action/capability/payload/lease/cleanup/policy/evidence 语言，但保留 `plan-approval` 与 `action-enforcement` 两个执行时点；前者不能替代真实请求的 Gateway 二次校验，后者也不能臆造整体批准或缺失的阻断原因。
_避免使用_：global approved boolean、approval bypasses gateway、gateway event as plan approval
