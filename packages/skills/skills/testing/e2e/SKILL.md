---
name: e2e
description: 当用户要求依据 PRD 完成浏览器 E2E 验收、真实链路验证、受控故障注入、可复跑回归资产或可追踪验收报告时使用。
---

# PRD 驱动 E2E 浏览器验收

把 PRD、审批、受控浏览器事实和同代测试资产编排成可审计闭环。默认使用本机系统 Google Chrome，由 Runtime 为每次运行创建一次性 Profile 并强制经过 Gateway；Skill 只组织中文语义步骤和用户交互，确定性计算与安全决定必须来自独立的 Runtime Host。

## 默认首次使用流程

1. 缺少 Runtime 时，只提示用户显式安装精确 `0.3.1`。
2. 运行 `~/.mutil-skills/bin/repo-e2e configure-browser --system`，验证并选择系统 Google Chrome；只有系统 Chrome 不可用且用户明确选择兜底时，才运行 `install-browser` 安装托管 Chromium。
3. 运行 `~/.mutil-skills/bin/repo-e2e configure-approval --mode local-confirmation`。默认流程不执行 `identity enroll`；WebAuthn 是用户显式选择的增强模式。
4. 运行 `~/.mutil-skills/bin/repo-e2e doctor --json`；仅在 `ready:true` 后创建 Run。
5. Execution Approval 必须取得 Runtime 返回的 `semanticReview`，按“PRD 原文 → Requirement → Rule → Oracle”完整展示；随后 Runtime 返回 `confirmation-required` 时，必须暂停并等待调用者明确确认，不得替用户确认，也不得继续执行后续边。
6. Runtime 完成最终化与报告渲染后，交付 `.biztest` 中的同代资产、脱敏证据和报告路径。

## Runtime 能力门

启动任何状态转换前读取 `skill.manifest.json`，并且只验证 `e2e.runtime-host`。固定执行 `~/.mutil-skills/bin/repo-e2e doctor --json`；只有安装清单、协议 major 与全部安全探针都通过，才允许调用 Runtime。`ready=false` 时进入 docs-only，原样展示 Doctor 的 `reasonCode` 与 `remediation`，不执行 Case、不生成审批、不发布资产。

| 唯一能力 | 机器证明 | 缺失时 |
| --- | --- | --- |
| Runtime Host | `doctor --json` 返回经过验证的 installation manifest、protocol major 和 safety probes | `environment-blocked / E2E_RUNTIME_HOST_UNAVAILABLE`，仅建议精确版本安装 |

缺失时只展示以下精确建议，不得自行执行：`npm exec --yes --package=@mutil-skills/e2e-runtime@0.3.1 -- repo-e2e install-runtime --version 0.3.1`。不得探测、导入或建议安装 Contracts、Engine、Authority、Gateway、Browser、Sanitizer、Report、Store 等低层包。

## 固定 Runtime JSON 调用协议

除 Doctor 外，唯一可执行入口是 `~/.mutil-skills/bin/repo-e2e rpc`。Skill 必须以参数数组直接启动固定绝对路径，不使用 shell，不拼接 PRD、路径、selector 或 secret。每次只构造一个协议 `1.0.0` 的严格 `RuntimeRequestEnvelope`，请求 JSON 只经标准输入写入；标准输出只接受一个严格 `RuntimeResponseEnvelope`。这就是本 Skill 唯一允许的 **JSON stdin/stdout** 协议。

`ok:true` 时先按该命令的结果契约读取业务结果；每个业务命令成功后必须立即调用 `get-status`，发送新的严格请求。只有 `get-status` 的 `result` 是公共状态投影，并且必须严格拒绝未知字段、完整提供 `state`、`nextEdge`、`verifiedDigests`、`minimumMissingInput`。Skill 只原样转述该投影，不补值、不猜测下一边、不自行计算摘要。`ok:false` 时只转述 `error.code/category/terminalState/resumeState/details`；响应版本、requestId、Runtime 身份或字段闭包不合法时进入 `environment-blocked`，不得把传输成功当业务成功。

真实命令包括 `create-run`、`submit-candidate`、`open-approval`、`confirm-approval`、`run-preflight`、`execute-run`、`prepare-manual-result`、`finalize-manual-result-role`、`finalize-run`、`get-status`、`"command":"resume-run"` 和 `"command":"render-report"`。恢复必须发送新的严格 `resume-run` envelope。本地模式下，人工 obligation 的 executor 与 reviewer 各需要一次独立、不可复用的确认；WebAuthn 模式继续使用两个不同登记身份。进入 `diagnosing` 且所需自动、人工和 N/A 事实齐全后发送 `finalize-run`，成功后再发送 `render-report`。不能把读取状态、重新执行或 Skill 自行渲染冒充恢复、最终化或报告命令。审批只认 Runtime 的主题绑定确认和 Authority 签名结果，不得把 `approved: true` 当作审批；secret 只传 `secretRef`，绝不传 secret value。

## 权威状态决策

每一步只通过 Runtime Host 获取 Engine `WorkflowDecision`，消费其中的 currentState、accepted/blocked、nextState、terminalState、resumeState、required IDs 和 artifact digests。Skill 不得维护状态顺序或终态副本；Runtime 未接受的边不执行。暂停时原样保存决定中的 resumeState、冻结 Case 队列和摘要。

## 按状态加载子流程

| 状态/职责 | 加载 |
| --- | --- |
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
| 证据、脱敏和 quarantine | [evidence-privacy.md](evidence-privacy.md) |
| Playwright 回归编译 | [regression-publication.md](regression-publication.md) |
| Verdict 和报告 | [report-verdict.md](report-verdict.md) |
| 同代原子发布与恢复 | [artifact-transaction.md](artifact-transaction.md) |

每次只加载当前状态需要的文件。子流程缺上游 artifact/digest 时只返回最小缺失项，不向前代替执行。

## 编排不变量

- Skill 不计算 SHA、覆盖率、审批有效性、verdict 或发布状态；只调用 Runtime Host，由 Runtime 内部协调 Contracts、Engine、Authority、Gateway、Browser、Sanitizer、Store 与 Report。
- 本地确认的 approver 只能表述为 `local-caller`，`identityVerified=false` 且 `separationOfDutiesVerified=false`；不得把默认调用者确认描述为已验证自然人身份或职责分离。
- `create-run` 必须由 Runtime 冻结有界 PRD 原文快照；Execution Approval 摘要必须携带同一原文、Requirement、Rule、Oracle、来源引用、映射依据与 `reviewDigest`。Skill 只能逐项原样展示，禁止摘要、截断、重排或自行补写；没有该字段、摘要漂移或存在空链时不得确认或执行。
- DiscoveryCapability 只允许冻结的静态导航和 DOM 读取；Execution Approval 前不执行 Case。
- 真实链路不加载注入规则；正式注入只由浏览器外 Safety Gateway 执行并签名计数。
- 写操作绑定 capability、attempt、DataLease 与 cleanup；每个写 action 必须生成、跨进程验签并落库一份结构化 `ExecutionOutcomeReceipt`，Authority reservation 的 outcomeDigest 必须等于回执 signedDigest；effect unknown 不自动重试。
- raw evidence 只进入 Git 外 quarantine；只有脱敏、扫描和必要人工复核通过的证据可发布。
- AI/Skill 只能产出声明式需求、Case、Action 与 Oracle；Engine 先把已批准 PRD/scope/lineage 密封为 generation readiness，Host 再固定 Authority 信任根；可执行 Playwright 源码只能由重算 Artifact content digest、固定公钥验签的可信 Projector + Compiler 在空目录生成。`playwrightAction`、源码 bytes、hook、环境读取和 caller 自报 Case ID 永远不能进入 CompilerInput。
- `trusted-read-only` 与 `trusted-reversible-write` 必须在运行前以 Host trust token 重验 V2 Discovery、Authority 当前 freshness、真实 Source Set（含 mediaType）、已审批 Run Bundle 的 runId、审批摘要和 Case/Action；执行时即时重建并递归密封快照、复验 CLI/Chrome、完成 token 级源码安全扫描，并用不可伪造、单次消费的 session 启动。读/写测试都只能调用同 session/launcher 派生的 loopback Bridge；Chrome/Proxy 路径、Bridge endpoint 和 RunGate 不接受逐 Run 自报。只读 Bridge 必须按已审批 `Case→Action` 映射收齐不可变结果集合；Browser Results 与 Evidence 必须来自该次 Bridge 触发的同一次真实浏览器执行，screenshot/DOM/Gateway summary 在 Runner 与发布入口之间以长度和内容 digest 双重绑定，不能事后重跑或用同长度 bytes 补证据。Chrome/Proxy 的 preflight check 必须来自执行前 Host opaque measurement capability，不能复制 execution fact；普通手写测试只能作为人工资产，或明确进入额外的 `production-isolated` Profile。
- `publication-ready` 先冻结唯一 FinalizationSnapshot，再由 Artifact Store 原子切换 active；先提交后算 verdict 无效。

## 对用户的阶段输出

每次回复给出当前状态、已验证 artifact/digest、下一条合法边、需要的最小输入或决定，以及当前不能宣称的内容。Execution Approval 回复必须先逐字展示 PRD 原文，再按 Requirement → Rule → Oracle 展示来源链并说明 `oracleMapping=explicit|requirement-level`，最后单独请求确认。最终结论只转述 Engine 复算结果；Firefox/WebKit 未执行时明确限定为 Chromium 验收。
