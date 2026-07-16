---
name: e2e
description: Use when 用户要求依据 PRD 完成浏览器 E2E 验收、真实链路验证、受控故障注入、可复跑回归资产或可追踪验收报告。
---

# PRD 驱动 E2E 浏览器验收

把 PRD、审批、受控 Chromium 事实和同代测试资产编排成可审计闭环。Skill 只组织语义步骤和用户交互；确定性计算与安全决定必须来自受信 Runtime。

## Runtime 能力门

启动任何状态转换前读取 `skill.manifest.json` 并验证全部 capability。能力缺失时按 manifest 的 `terminalState` 和 `reasonCode` 返回结构化阻塞；保留 `resumeState`、缺失 capability 和已有 artifact digest。

| 能力 | 证明 | 缺失时 |
| --- | --- | --- |
| Contracts | `@mutil-skills/e2e-contracts` 可解析当前 Schema major | 缺包为 `environment-blocked`；major 不兼容为 `migration-required` |
| Engine | `@mutil-skills/e2e-engine` 状态机、审计和 verdict API 可调用 | `environment-blocked` |
| Authority | 独立 Authority 进程、受信公钥和审批 UI 可用 | `safety-blocked` |
| Safety Gateway | 独立 Gateway/Egress Guard 可安装签名 policy | `safety-blocked` |
| 受控 Chromium | `@mutil-skills/e2e-playwright-runtime`、Chromium sandbox 和 Host 启动器可用 | `environment-blocked` |
| Sanitizer | 分类型 sanitizer、scanner 和 quarantine 可用 | `safety-blocked` |
| Report | `@mutil-skills/e2e-report` 可从 final-report 渲染 | `environment-blocked` |
| Artifact Runtime | macOS/Linux 的 POSIX 本地文件系统、Python 3.9+、advisory lock、dirfd no-follow 和目录 fsync 可用 | `artifact-blocked` |

任一能力没有机器可验证的证明时进入 docs-only：只解释缺失项和恢复方式，不执行 Case、不生成签名审批、不计算 verdict、不发布 active generation，也不宣称已经完成 E2E。

## 权威状态决策

每一步先调用 Engine `transition()`，只消费其 `WorkflowDecision` 中的 currentState、accepted/blocked、nextState、terminalState、resumeState、required IDs 和 artifact digests。Skill 不得维护状态顺序或终态副本；Engine 未接受的边不执行。暂停时原样保存决定中的 resumeState、冻结 Case 队列和摘要。

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

- Skill 不计算 SHA、覆盖率、审批有效性、verdict 或发布状态；调用 Contracts、Engine、Authority、Gateway、Runtime、Sanitizer、Store、Report 的确定性接口。
- DiscoveryCapability 只允许冻结的静态导航和 DOM 读取；Execution Approval 前不执行 Case。
- 真实链路不加载注入规则；正式注入只由浏览器外 Safety Gateway 执行并签名计数。
- 写操作绑定 capability、attempt、DataLease 与 cleanup；每个写 action 必须生成、跨进程验签并落库一份结构化 `ExecutionOutcomeReceipt`，Authority reservation 的 outcomeDigest 必须等于回执 signedDigest；effect unknown 不自动重试。
- raw evidence 只进入 Git 外 quarantine；只有脱敏、扫描和必要人工复核通过的证据可发布。
- AI/Skill 只能产出声明式需求、Case、Action 与 Oracle；Engine 先把已批准 PRD/scope/lineage 密封为 generation readiness，Host 再固定 Authority 信任根；可执行 Playwright 源码只能由重算 Artifact content digest、固定公钥验签的可信 Projector + Compiler 在空目录生成。`playwrightAction`、源码 bytes、hook、环境读取和 caller 自报 Case ID 永远不能进入 CompilerInput。
- `trusted-read-only` 与 `trusted-reversible-write` 必须在运行前以 Host trust token 重验 V2 Discovery、Authority 当前 freshness、真实 Source Set（含 mediaType）、已审批 Run Bundle 的 runId、审批摘要和 Case/Action；执行时即时重建并递归密封快照、复验 CLI/Chrome、完成 token 级源码安全扫描，并用不可伪造、单次消费的 session 启动。读/写测试都只能调用同 session/launcher 派生的 loopback Bridge；Chrome/Proxy 路径、Bridge endpoint 和 RunGate 不接受逐 Run 自报。只读 Bridge 必须按已审批 `Case→Action` 映射收齐不可变结果集合；Browser Results 与 Evidence 必须来自该次 Bridge 触发的同一次真实浏览器执行，screenshot/DOM/Gateway summary 在 Runner 与发布入口之间以长度和内容 digest 双重绑定，不能事后重跑或用同长度 bytes 补证据。Chrome/Proxy 的 preflight check 必须来自执行前 Host opaque measurement capability，不能复制 execution fact；普通手写测试只能作为人工资产，或明确进入额外的 `production-isolated` Profile。
- `publication-ready` 先冻结唯一 FinalizationSnapshot，再由 Artifact Store 原子切换 active；先提交后算 verdict 无效。

## 对用户的阶段输出

每次回复给出当前状态、已验证 artifact/digest、下一条合法边、需要的最小输入或决定，以及当前不能宣称的内容。最终结论只转述 Engine 复算结果；Firefox/WebKit 未执行时明确限定为 Chromium 验收。
