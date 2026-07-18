# 受控浏览器执行

## 适用状态

`execution-approved → compiled → running-real → running-injection → diagnosing | finalizing`。

## 必需 Artifact 与摘要

不可变 v2 `run-bundle`、`execution-contract`、V2 `regression-manifest`、v2 `approval-grants` freshness receipt、`data-leases`、Gateway session 和 v2 Action Map。每个动作按 `actionId + operation` 绑定全部真实 capabilityId/digest。执行 Profile 必须是 `trusted-read-only`、`trusted-reversible-write` 或 `production-isolated`，且与 Discovery attestation、manifest 和 final-report 完全一致。

## 允许的语义输出

浏览器 observation 和结构化 step actual 候选；标准输出为 `workflow-events`、带实际
`executedBrowserIds` 的 `browser-results` 和原始 evidence refs。

## 调用的确定性 API

Skill 唯一调用固定 launcher `~/.mutil-skills/bin/repo-e2e rpc`，按 JSON stdin/stdout 发送严格 `RuntimeRequestEnvelope` 并解析严格 `RuntimeResponseEnvelope`。每个业务命令成功后必须立即调用 `get-status`；只有严格拒绝未知字段的 `get-status` `result` 才提供 `state`、`nextEdge`、`verifiedDigests`、`minimumMissingInput`，其他命令结果不得用于猜测状态；下列执行器、Browser、Gateway 与 Authority 机制均由 Runtime 内部托管，Skill 不得直接调用或导入。

Runtime 内部必须调用 `prepareTrustedCompilerRun()`、固定 `executeTrustedCompilerProject()` launcher/Chromium Runtime、Gateway client、Engine attempt/classification API 和 Authority 事件链追加接口。`trusted-*` Profile 只接受 Host 启动期 trust token：其中钉扎 Discovery/Approval 信任根、Chrome bytes 和 Gateway Proxy；执行前动态复验 V2 Discovery、Authority 当前 freshness、真实 Source Set、已审批 Run Bundle、Case/Action 和审批摘要后才创建不可伪造 session。launcher 在执行瞬间从已证明 bytes 创建、复验并递归密封私有快照。只读入口使用 `createTrustedCompilerControlledReadLauncher()`，生成测试只向 loopback Bridge 提交声明式 Action，由同 session 的 Runner 驱动真实 Page 并产出唯一 Case Result/Evidence；写入口使用 `createTrustedCompilerControlledWriteLauncher()`。每个 session 只能认领一个对应 Profile 的 launcher，Bridge 必须是同一 session/launcher 派生的 opaque handle。正式写 Runner 仍只接受来源绑定的 approval/lease clients，并核对 in-process-test 或 authenticated-rpc transport；authenticated-rpc 还必须绑定同一 Authority RPC 公钥摘要。`test-only` freshness client 只能用于明确的 Runner 单元/集成测试，不能进入 authenticated-rpc。Runner 不接受调用方自报的 sandbox/gateway 健康布尔值、Chrome 路径、Proxy endpoint、Bridge endpoint、RunGate 或回执验签材料。只有未由可信 Compiler 生成的外部测试代码才进入 `production-isolated` Profile：此时必须额外复算同代 `RuntimeIsolationPolicy` 与 Run Bundle 摘要，并验证隔离 Authority attestation。Runner 在访问页面前动态调用 `write.verifyForSubject.v1` 与 `lease.verifyTarget.v1`，以执行瞬间的 Authority/Lease 状态作决定。

## 执行步骤

Runtime 启动生成测试前必须先调用 `prepareTrustedCompilerRun()`；它失败时不得创建浏览器动作或 Bridge。每角色创建独立 Context；先执行 real-environment 与健康基线，再为每个 injection Case 创建新 Context/policy；逐步记录 attempt slot、action、actual、effectObservation 和 evidence ref。写动作必须先且只能匹配 grant 中同 actionId 的一个 reversible-write capability，再动态复验 currentSubject、撤销/过期/nonce 状态、leaseId、fencingToken，以及 capability 中全部 request 的 targetFingerprint；任一失败都不得触碰页面。Gateway 对每个写请求记录签名发布审计；清理完成后，Gateway 必须使用 `execution-outcome-receipt/v1` 专用 purpose 签发完整 `ExecutionOutcomeReceipt`，绑定 `assetId、generationId、prdRevision、runId、caseId` AttemptContext、Grant/Capability/Action/Reservation、Runner 结果、Gateway 策略和请求计数、cleanup plan/lease/结果以及 evidence 集合。Authority reservation 的 `outcomeDigest` 必须等于该回执 `signedDigest`，然后 Gateway 记录 `reservationId + completed + outcomeDigest + consumed=true`。受控桥和独立 Playwright 子进程都必须重算 binding 并验证 Ed25519；回执按 `actionId` 写入 `browser-results.executionOutcomeReceipts[]`，staging 再与 Gateway、cleanup、evidence 和 Attempt 逐项复核。`passed|failed` terminal 必须显式携带同一 `reservationId + outcomeDigest`。当前每代只允许一个 scheduled actor；多角色单代缺少 per-case actor/preflight 证明时必须 fail-closed。

## 退出条件

每个可执行 Case 有唯一 terminal attempt 或结构化阻塞；real/injection 分区完整；事件链和 Gateway 计数可验。

## 暂停条件

浏览器崩溃、会话过期、页面身份变化、Capability/Lease 失效、未知副作用或证据管线不可用。

## 禁止行为

不得让 Runtime 接收自然语言授权，不得接受调用方提供的 `grantValid/leaseValid` 布尔值或结构伪造 verifier 代替动态复验，不得伪造 trusted session，不得在 Source Set 复验前启动生成测试，不得在 real 模式加载注入，不得复用角色 Context，不得用 synthetic/composite capability 替代真实 operation capability，也不得直接运行未门控写测试。普通手写测试不能标记为 `trusted-*`；需要执行时只能进入单独的 `production-isolated` Profile，手工验收则保持非自动化资产。

## 独立调用

缺少必需 artifact/digest 时，只返回最小缺失项；不得重建上游，不得推进状态。
