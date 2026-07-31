# 多 Case 使用独立 Attempt、Cleanup 和恢复

## 状态

Accepted

## 日期

2026-07-31

## 背景

单 Case 中聚合大量 checkpoint 可以验收一个旅程，但无法独立表达不同业务场景的失败、重试、角色、Cleanup 和恢复。简单循环又会在崩溃后重复未知写操作。

## 决策

一个 Generation 可以冻结多个 Case。第一版按 queue ordinal 串行调度；每个 Case 拥有独立 actor、Attempt、结果、Evidence、Cleanup 和 terminal。effect unknown 永不自动重试，Cleanup 未完成时恢复优先 Cleanup，已 terminal Case 不重放。

Runtime 在每个 Case 执行前持久化 `running + attemptId + WriteAttempt`，在 Case 闭合后持久化 terminal、执行结果、Gateway/Outcome 签名事实和隔离证据。进程中断后，`resume-run` 必须先由 Recovery Coordinator 对账当前 running Attempt，再为原 execution attempt 取得新的 fenced owner；执行器只能恢复该 Attempt，并从下一个 pending Case 继续。

Finalization 不把多个 Case 压成单一结果。每个 Case 先独立完成授权、Outcome、Gateway、Cleanup、Oracle 和证据校验，再聚合为同代 `workflow-events`、`browser-results`、`gateway-audit.sessions`、`browser-evidence`、`data-leases` 与 `cleanup-results`。多个 ExecutionOutcome/Gateway/Sanitizer verifier material 按 Case 保留。

## 备选方案

- 继续使用 mega Case：拒绝，因为 Case 级 verdict 和恢复事实被掩盖。
- 立即并行执行：拒绝，因为会扩大 Lease、Gateway 和恢复的并发状态空间。
- 崩溃后从头运行：拒绝，因为写副作用可能重复。

## 影响

- Scheduler cursor 必须持久化并有摘要。
- full-playwright projector 必须逐 scheduled Case 闭合 program、action、grant、lease 和 cleanup。
- 恢复请求必须携带当前 Case 的持久 attemptId；旧 execution attempt 若没有原请求摘要则 fail closed。
- 已 terminal Case 的结果和证据不得由恢复执行器重新生成。
- 后续并发可以建立在同一 Case 契约上，而不修改报告语义。
