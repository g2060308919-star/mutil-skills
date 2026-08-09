---
name: e2e
description: 当用户要求依据 PRD 完成浏览器 E2E 验收、真实链路验证、受控故障注入、可复跑回归资产或可追踪验收报告时使用。
---

# PRD 驱动 E2E 浏览器验收

把 PRD、审批、受控浏览器事实和同代测试资产编排成可审计闭环。默认使用本机系统 Google Chrome，由 Runtime 为每次运行创建一次性 Profile 并强制经过 Gateway；Skill 只组织中文语义步骤和用户交互，确定性计算与安全决定必须来自独立的 Runtime Host。

调用者的最小输入是 PRD 来源、唯一验证地址，以及目标需要登录时的可用角色/secret ref。不得要求调用者手工创建 `.biztest/project.json`、requirements contract、machine view、source bundle 或 project policy；这些是 Skill 自动准备并交给 Runtime 冻结的内部材料。若目标不属于代码仓库，Skill 应创建独立、可持续到 Run 结束的接入工作区；若项目已有身份或 policy，必须复用且不得覆盖。

## Runtime 0.8.x 工作流契约

Skill 版本与 Runtime 版本必须同为 `0.8.x`，并由 `skill.manifest.json` 的精确版本和 `doctor --json` 返回值进一步闭合。新 Run 的高层主线固定为：`create-run` 冻结来源，`prepare-prd-understanding` 固化唯一语义投影，`compile-prd-run` 编译 Case/Action/Oracle，`configure-target` 配置目标，`probe-target` 做无副作用浏览器诊断，随后 `get-acceptance-review` 与 `confirm-acceptance-review` 完成执行前语义确认。每条业务边之后立即执行 `get-status`，只按 Runtime 返回的 `nextEdge` 继续。

`submit-candidate` 不属于新 Run 的默认主线，只为 Runtime 明确返回该边的旧 Run/旧 Artifact 流程保留。不得因为旧文档示例存在该命令，就跳过 `compile-prd-run`、目标配置、目标探测或语义确认。严格 JSON 只由 Skill/Facade 构造；当 Runtime 拒绝输入时，向调用者展示 `validationIssues` 的字段路径、约束与修复建议，而不是只返回“envelope 无效”。

## 默认首次使用流程

1. 先加载 [prd-understanding.md](prd-understanding.md)。已有当前、已确认且 route 指向 `e2e` 的唯一 requirements contract 时直接复用；否则优先恰好调用一次已安装的 `$understand-prd`。若该外部 Skill 不可用，就由本 Skill 按 `prd-understanding.md` 内置流程完成同一次来源收集、问题闭合、节点化和契约确认；两条路径互斥，绝不执行两次，也不得另写一份 PRD 总结。
2. 缺少 Runtime 时，只提示用户显式安装精确 `0.8.0`。
3. 运行 `~/.mutil-skills/bin/repo-e2e configure-browser --system`，验证并选择系统 Google Chrome；只有系统 Chrome 不可用且用户明确选择兜底时，才运行 `install-browser` 安装托管 Chromium。
4. 运行 `~/.mutil-skills/bin/repo-e2e configure-approval --mode local-confirmation`。默认流程不执行 `identity enroll`；WebAuthn 是用户显式选择的增强模式。
5. 运行 `~/.mutil-skills/bin/repo-e2e resolve-runtime --offline`，从本机受控 closure 解析精确 Runtime 版本与 installation digest；默认不得联网，也不得把 `current` 字样当成 Run 身份。需要复现指定版本时改用 `--pinned <exact-version> [--digest <sha256:...>]`。把同一选择写入 `prepare-input` 草稿的 `runtimePolicy`，使 `create-run` 在安装锁内按该策略重新解析并固化同一 installation；不得只运行查询命令后丢弃策略。
6. 运行 `~/.mutil-skills/bin/repo-e2e doctor --json`；仅在 Resolver 成功且 `ready:true` 后创建 Run。
7. Skill 逐字读取 PRD 与必要来源一次，完成同一次需求理解并取得调用者确认后，把这些已读取 bytes 通过 `~/.mutil-skills/bin/repo-e2e prepare-input` 自动封装；该命令不联网、不重新理解 PRD，只幂等创建接入工作区中的 `.biztest/project.json`、requirements contract、来源快照和 project policy，并返回严格 `create-run` payload。不得要求调用者手工创建这些内部文件或手写 JSON。`create-run` 同时冻结带严格 front matter 的唯一 requirements contract 原文、主 PRD 与执行所需依赖来源；把 Runtime 返回的 `understandingContractDigest`、`sourceRevision` 与 Source Bundle 绑定进同一契约的 E2E execution projection。调用一次 `prepare-prd-understanding`，让 Runtime 复算并持久化唯一 prepared projection。随后把声明式 Case、Action 和 Oracle 设计一次性交给 `compile-prd-run`；只使用 Runtime 返回的稳定 Case ID、Action ID、Oracle ID、`compilerDigest` 和 `caseSchedule`，不得由 Skill 生成或覆盖这些可信事实。
8. 根据用户给出的唯一验证地址配置 `TargetContract`，明确环境、目标 URL、允许导航 origin 与可配置页面身份策略；立即由系统 Chrome 在任何授权前执行无副作用 Target Probe。命令行无法访问 localhost 不是目标不可用的证明，浏览器侧探测结果才是诊断依据。Probe 只确认地址可达和页面身份，不推导 locator、不执行 Case、不产生写请求。
9. 覆盖资产与 Target Probe 齐备后取得 Runtime 的 `AcceptanceReview`，在 Discovery 授权和可信浏览器预检前按“PRD 原文 → Clause 原文与处置 → Requirement → Rule → Oracle → Case”向调用者展示，并用 `review --run` 读取、`confirm-review --run` 确认当前 `reviewDigest`。Runtime 返回 `confirmation-required` 时必须暂停并等待调用者明确确认；确认前不得执行 Discovery、可信浏览器预检或 locator 绑定。该确认只核对 LLM 的需求、交互、范围和用例理解；它不是 Execution Approval，也不是第二次 `$understand-prd`。确认后按 Runtime `nextEdge` 完成 Discovery、只读预检与绑定、执行审批和 Case 执行。
10. Runtime 完成最终化后调用 `render-report`。需要指定位置时传 `outputRoot`；否则报告写入 `~/.mutil-skills/e2e/reports/<asset-id>/<run-id>/`。交付独立 Run Workspace 中的 JSON、Markdown、HTML、原始 PNG 和 Playwright Trace；`.biztest`、Git、CI Artifact 和对象存储只作为可选发布适配器。

## Runtime 能力门

启动任何状态转换前读取 `skill.manifest.json`，并且只验证 `e2e.runtime-host`。先固定执行 `~/.mutil-skills/bin/repo-e2e resolve-runtime --offline`，再执行 `~/.mutil-skills/bin/repo-e2e doctor --json`；只有解析出的精确 installation、安装清单、协议 major 与全部安全探针都通过，才允许调用 Runtime。Resolver 或 Doctor 失败时进入 docs-only，原样展示 `reasonCode` 与 `remediation`，不执行 Case、不生成审批、不发布资产。

| 唯一能力 | 机器证明 | 缺失时 |
| --- | --- | --- |
| Runtime Host | `doctor --json` 返回经过验证的 installation manifest、protocol major 和 safety probes | `environment-blocked / E2E_RUNTIME_HOST_UNAVAILABLE`，仅建议精确版本安装 |

缺失时只展示以下精确建议，不得自行执行：`npm exec --yes --package=@mutil-skills/e2e-runtime@0.8.0 -- repo-e2e install-runtime --version 0.8.0`。不得探测、导入或建议安装 Contracts、Engine、Authority、Gateway、Browser、Sanitizer、Report、Store 等低层包。

## 面向调用者的友好门面

调用者不需要构造 `RuntimeRequestEnvelope`，也不需要理解 requestId、project identity 或状态跳转。Skill 使用 Runtime 的 `Facade` 生成 envelope、跟随 `nextEdge`，并把 `reasonCode`、`remediation`、RunHandle 与最小缺失输入原样呈现。面向调用者和排障优先使用固定 launcher 的友好命令：

- `~/.mutil-skills/bin/repo-e2e status --run <RUN>`：读取当前阶段、condition、`semanticCases`、保留/失效资产和下一步，并刷新 `~/.mutil-skills/e2e/runs/<asset>/<run>/run-status.html`。
- `~/.mutil-skills/bin/repo-e2e resolve-runtime --offline`：离线验证并选择当前受控 Runtime closure；`--pinned <exact-version> [--digest <sha256:...>]` 用于精确复现。未配置生产 TUF 服务时不得使用 `--stable`，`latest` 始终拒绝。
- `~/.mutil-skills/bin/repo-e2e prepare-input`：从标准输入接收 Skill 已读取并确认的 PRD/契约/必要来源 bytes 以及已选择的 `runtimePolicy`，创建私有、不可变接入快照并输出 `create-run` payload；它不发起网络请求，也不替代需求理解。
- `~/.mutil-skills/bin/repo-e2e review --run <RUN>`：展示不可改写的 AcceptanceReview。
- `~/.mutil-skills/bin/repo-e2e confirm-review --run <RUN> --digest <sha256:...>`：只确认当前语义审查摘要。
- `~/.mutil-skills/bin/repo-e2e retry --run <RUN>`：仅重试 Runtime 明确标为可恢复的 Target Probe 或 preflight，不重放写操作。
- `~/.mutil-skills/bin/repo-e2e report --run <RUN>`：读取正式最终报告；`--run-id` 仅保留为旧调用兼容别名。

内部仍通过下节 JSON 协议提交复杂声明式资产，这是 Skill/Facade 的实现细节，不得要求用户手写 JSON envelope。

## 固定 Runtime JSON 调用协议

除 Doctor 和无状态转换的 `prepare-input` 接入助手外，唯一可执行入口是 `~/.mutil-skills/bin/repo-e2e rpc`。Skill 必须以参数数组直接启动固定绝对路径，不使用 shell，不拼接 PRD、路径、selector 或 secret。每次只构造一个协议 `1.0.0` 的严格 `RuntimeRequestEnvelope`，请求 JSON 只经标准输入写入；标准输出只接受一个严格 `RuntimeResponseEnvelope`。这就是本 Skill 唯一允许的 **JSON stdin/stdout** 协议。

`ok:true` 时先按该命令的结果契约读取业务结果；每个业务命令成功后必须立即调用 `get-status`，发送新的严格请求。只有 `get-status` 的 `result` 是公共状态投影，并且必须严格拒绝未知字段、完整提供 `state`、`nextEdge`、`verifiedDigests`、`minimumMissingInput`。Skill 只原样转述该投影，不补值、不猜测下一边、不自行计算摘要。`ok:false` 时只转述 `error.code/category/terminalState/resumeState/details`；响应版本、requestId、Runtime 身份或字段闭包不合法时进入 `environment-blocked`，不得把传输成功当业务成功。

`prepare-prd-understanding` 后必须先消费 `get-status` 返回的 `compile-prd-run` 边，并提交一份严格 `DeclarativePrdRunDesign`。Runtime 负责完整性检查、稳定 ID、摘要和串行 Case 调度；Skill 不得提交 `compilerDigest`、Artifact ID、审批事实或 verdict。`submit-candidate` 仅作为旧 Run 的兼容 interface；若 `get-status` 明确返回该边，仍只能按 `minimumMissingInput` 补交 Runtime 要求的兼容资产，不得自行跳过高层编译、状态边或阶段门。

真实命令包括 `create-run`、`prepare-prd-understanding`、`compile-prd-run`、`get-acceptance-review`、`confirm-acceptance-review`、`configure-target`、`probe-target`、兼容用 `submit-candidate`、`open-approval`、`confirm-approval`、`run-preflight`、`execute-run`、`prepare-manual-result`、`finalize-manual-result-role`、`finalize-run`、`get-status`、`"command":"resume-run"` 和 `"command":"render-report"`。恢复必须发送新的严格 `resume-run` envelope。本地模式下，人工 obligation 的 executor 与 reviewer 各需要一次独立、不可复用的确认；WebAuthn 模式继续使用两个不同登记身份。进入 `diagnosing` 且所需自动、人工和 N/A 事实齐全后发送 `finalize-run`，成功后再发送 `render-report`。不能把读取状态、重新执行或 Skill 自行渲染冒充恢复、最终化或报告命令。审批只认 Runtime 的主题绑定确认和 Authority 签名结果，不得把 `approved: true` 当作审批；secret 只传 `secretRef`，绝不传 secret value。

## 权威状态决策

每一步只通过 Runtime Host 获取 Engine `WorkflowDecision`，消费其中的 currentState、accepted/blocked、nextState、terminalState、resumeState、required IDs 和 artifact digests。Skill 不得维护状态顺序或终态副本；Runtime 未接受的边不执行。暂停时原样保存决定中的 resumeState、冻结 Case 队列和摘要。

## 按状态加载子流程

| 状态/职责 | 加载 |
| --- | --- |
| PRD 契约理解与交接 | [prd-understanding.md](prd-understanding.md) |
| 来源冻结 | [prd-intake.md](prd-intake.md) |
| 范围审批 | [scope-approval.md](scope-approval.md) |
| 需求、规则、oracle 和流程 | [requirement-oracles.md](requirement-oracles.md) |
| obligation、Case 和设计审计 | [coverage-universe.md](coverage-universe.md) |
| 执行主题与最终审批 | [execution-approval.md](execution-approval.md) |
| 数据租约与清理 | [data-and-cleanup.md](data-and-cleanup.md) |
| 只读预检与动作绑定 | [browser-preflight-binding.md](browser-preflight-binding.md) |
| 出站与副作用门 | [safety-gateway.md](safety-gateway.md) |
| 真实/注入执行 | [browser-execution.md](browser-execution.md) |
| 诊断与有界自愈 | [diagnosis-healing.md](diagnosis-healing.md) |
| 原始截图/Trace、敏感文本证据和 quarantine | [evidence-privacy.md](evidence-privacy.md) |
| Playwright 回归编译 | [regression-publication.md](regression-publication.md) |
| Verdict 和报告 | [report-verdict.md](report-verdict.md) |
| 同代原子发布与恢复 | [artifact-transaction.md](artifact-transaction.md) |

每次只加载当前状态需要的文件。子流程缺上游 artifact/digest 时只返回最小缺失项，不向前代替执行。

## 编排不变量

- Skill 不计算 SHA、覆盖率、审批有效性、verdict 或发布状态；只调用 Runtime Host，由 Runtime 内部协调 Contracts、Engine、Authority、Gateway、Browser、Sanitizer、Store 与 Report。
- `$understand-prd` 或本 Skill 内置等价流程生成的 requirements contract 是唯一 PRD 语义真相；两条创建路径互斥且只执行一次。不得再次运行 `$understand-prd` 或重复内置流程。`prd-request` 必须逐字复用 Runtime 保存的唯一 prepared projection。Clause 绑定原文锚点，Requirement/Rule/Flow 通过 `contractNodeIds` 绑定契约节点，Oracle 通过 `contractAcceptanceCriteria` 完整且唯一地绑定契约验收条件，再沿 Coverage/Case/Evidence 闭合。不得把 E2E 建模结果反写成第二份需求契约，或把 `confirmed-by-caller` 冒充 Runtime/Authority 审批。
- 本地确认的 approver 只能表述为 `local-caller`，`identityVerified=false` 且 `separationOfDutiesVerified=false`；不得把默认调用者确认描述为已验证自然人身份或职责分离。
- `create-run` 必须由 Runtime 冻结唯一契约原文及有界 PRD Source Bundle，校验契约 front matter，并限制来源总量；`prd-manifest` 必须列出完整 Clause Inventory，`acceptance-scope` 必须让每个 Clause 恰好一次处于 modeled、excluded、not-applicable 或 ambiguous。Execution Approval 摘要必须携带同一原文、Clause 原文与处置、Requirement、Rule、Oracle、来源引用、映射依据与 `reviewDigest`。Skill 只能逐项原样展示，禁止摘要、截断、重排或自行补写；没有该字段、摘要漂移、Clause 未处置或存在空链时不得确认或执行。
- DiscoveryCapability 只允许冻结的静态导航和 DOM 读取；Execution Approval 前不执行 Case。
- 真实链路不加载注入规则；正式注入只由浏览器外 Safety Gateway 执行并签名计数。
- 写操作绑定 capability、attempt、DataLease 与 cleanup；每个写 action 必须生成、跨进程验签并落库一份结构化 `ExecutionOutcomeReceipt`，Authority reservation 的 outcomeDigest 必须等于回执 signedDigest；effect unknown 不自动重试。
- 原始 PNG 和 Playwright Trace 可以按产品决定原字节发布到本地独立 Run Workspace；Runtime 仍必须证明其 Case/Action/Attempt 来源并校验路径、媒体、摘要和权限。DOM、console、network、storage 等文本或结构化证据继续进入 Git 外 quarantine，并执行扫描、必要脱敏和人工复核。
- AI/Skill 只能产出声明式需求、Case、Action 与 Oracle；Engine 先把已批准 PRD/scope/lineage 密封为 generation readiness，Host 再固定 Authority 信任根；可执行 Playwright 源码只能由重算 Artifact content digest、固定公钥验签的可信 Projector + Compiler 在空目录生成。`playwrightAction`、源码 bytes、hook、环境读取和 caller 自报 Case ID 永远不能进入 CompilerInput。
- `trusted-read-only` 与 `trusted-reversible-write` 必须在运行前以 Host trust token 重验 V2 Discovery、Authority 当前 freshness、真实 Source Set（含 mediaType）、已审批 Run Bundle 的 runId、审批摘要和 Case/Action；执行时即时重建并递归密封快照、复验 CLI/Chrome、完成 token 级源码安全扫描，并用不可伪造、单次消费的 session 启动。读/写测试都只能调用同 session/launcher 派生的 loopback Bridge；Chrome/Proxy 路径、Bridge endpoint 和 RunGate 不接受逐 Run 自报。只读 Bridge 必须按已审批 `Case→Action` 映射收齐不可变结果集合；Browser Results 与 Evidence 必须来自该次 Bridge 触发的同一次真实浏览器执行，screenshot/DOM/Gateway summary 在 Runner 与发布入口之间以长度和内容 digest 双重绑定，不能事后重跑或用同长度 bytes 补证据。Chrome/Proxy 的 preflight check 必须来自执行前 Host opaque measurement capability，不能复制 execution fact；普通手写测试只能作为人工资产，或明确进入额外的 `production-isolated` Profile。
- `publication-ready` 先冻结唯一 FinalizationSnapshot，再由 Artifact Store 原子切换 active；先提交后算 verdict 无效。

## 对用户的阶段输出

每次回复给出当前状态、已验证 artifact/digest、`semanticCases`、`preservedAssets`、`invalidatedAssets`、下一条合法边、需要的最小输入或决定，以及当前不能宣称的内容；同时给出 `run-status.html` 的位置。浏览器预检前的 AcceptanceReview 必须逐字展示 PRD 原文，再逐条展示 Clause 原文、`sourceSpan` 与处置，然后按 Requirement → Rule → Oracle → Case 展示来源链并单独请求确认。Execution Approval 再展示实际浏览器动作、环境、网络与副作用主题。最终结论只转述 Engine 复算结果；Firefox/WebKit 未执行时明确限定为 Chromium 验收。
