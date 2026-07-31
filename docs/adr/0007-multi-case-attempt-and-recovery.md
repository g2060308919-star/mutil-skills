# 多 Case 使用独立 Attempt、Cleanup 和恢复

## 状态

Accepted

## 日期

2026-07-31

## 背景

单 Case 中聚合大量 checkpoint 可以验收一个旅程，但无法独立表达不同业务场景的失败、重试、角色、Cleanup 和恢复。简单循环又会在崩溃后重复未知写操作。

## 决策

一个 Generation 可以冻结多个 Case。第一版按 queue ordinal 串行调度；每个 Case 拥有独立 actor、Attempt、结果、Evidence、Cleanup 和 terminal。effect unknown 永不自动重试，Cleanup 未完成时恢复优先 Cleanup，已 terminal Case 不重放。

## 备选方案

- 继续使用 mega Case：拒绝，因为 Case 级 verdict 和恢复事实被掩盖。
- 立即并行执行：拒绝，因为会扩大 Lease、Gateway 和恢复的并发状态空间。
- 崩溃后从头运行：拒绝，因为写副作用可能重复。

## 影响

- Scheduler cursor 必须持久化并有摘要。
- full-playwright projector 必须逐 scheduled Case 闭合 program、action、grant、lease 和 cleanup。
- 后续并发可以建立在同一 Case 契约上，而不修改报告语义。
