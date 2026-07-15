# 诊断、尝试选择与有界自愈

## 适用状态

在 `running-real | running-injection` 内完成有界 attempt；最终分类只走 `diagnosing → finalizing`。

## 必需 Artifact 与摘要

`workflow-events v2` 落盘链、`browser-results v2`、Action Map、Case oracle、Gateway audit、evidence refs，以及 Attempt Authority 发布的专用验签材料。每个 Case 的权威输入至少包含 runId、retryPolicy、initialChainDigest、attempt events、selection 与 workflowDigest。

## 允许的语义输出

business/input/environment/safety/automation/pending 分类候选，以及仅限 locator/wait/action/evidence/routePattern 的修订建议。

## 调用的确定性 API

调用 Engine `classify()`、持久化 attempt 审计、attempt slot 验链/选择和 retry policy；执行器只向 Attempt Authority 的 `appendAttemptEvent()` 提交完整上下文和事件，由 Authority 自行验证状态转换、计算链摘要并签名；使用独立 verifier 验证每个 event proof。需要修订时重新计算 ApprovalSubject 并由 Authority 撤销旧 grant。

## 执行步骤

在运行状态内按页面身份、角色、数据、Gateway、环境、oracle、自动化顺序诊断单次失败；先从落盘 artifact 重算初始链、事件链和 workflowDigest，校验 generation/asset/PRD/run/case 绑定、slot 连续性、started→terminal 顺序、事件时间单调、proof purpose/keyId/signature 与前后摘要。再把每个 terminal 的 status、mode、effect、effectObservation、reservationSafeToVoid 与 `browser-results v2` 精确对齐；`passed|failed` 还必须把 terminal 的 reservationId/outcomeDigest 与 Gateway 签名 reservation 精确对齐；只有 effect-aware retry 规则允许时才生成下一 slot。所有 slot 结束再进入 `diagnosing`，冻结 final attempt、分类、change digest 和 assertionChanged=false，然后请求 `finalizing`。

## 退出条件

每个 Case 有可复算的唯一 selection、selectedAttemptId、完整 event-chain digest 和分类；运行状态内的允许重试已成功或安全耗尽；`diagnosing` 只退出到 Engine 接受的 `finalizing`。

## 暂停条件

证据不足、effect unknown、业务预期未决，或修改 Action Map/lease/environment 导致重新审批。

## 禁止行为

不得修改 PRD、产品代码、Case 必要性、oracle 或断言强度；Attempt Authority 不得提供任意摘要签名接口；不得跳 slot、删除或重排事件、伪造 terminal event、复用其他 generation/run/case 的 proof，或重试可能已生效的写；不得把 diagnosis 中的选择说明当作权威事实。

## 独立调用

缺少必需 artifact/digest 时，只返回最小缺失项；不得重建上游，不得推进状态。
