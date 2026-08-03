# 诊断、尝试选择与有界自愈

## 适用状态

在 `running-real | running-injection` 内完成有界 attempt；最终分类只走 `diagnosing → finalizing`。

## 必需 Artifact 与摘要

`workflow-events v2` 落盘链、`browser-results v2`、Action Map、Case oracle、Gateway audit、evidence refs，以及 Attempt Authority 发布的专用验签材料。每个 Case 的权威输入至少包含 runId、retryPolicy、initialChainDigest、attempt events、selection 与 workflowDigest。

## 允许的语义输出

business/input/environment/safety/automation/pending 分类候选，以及仅限 locator/wait/action/evidence/routePattern 的修订建议。

## 调用的确定性 API

Skill 唯一调用固定 launcher `~/.mutil-skills/bin/repo-e2e rpc`，按 JSON stdin/stdout 发送严格 `RuntimeRequestEnvelope` 并解析严格 `RuntimeResponseEnvelope`。每个业务命令成功后必须立即调用 `get-status`；只有严格拒绝未知字段的 `get-status` `result` 才提供 `state`、`nextEdge`、`verifiedDigests`、`minimumMissingInput`，其他命令结果不得用于猜测状态；崩溃或 pending attempt 只能发送真实的 `"command":"resume-run"`，不得自动重放 Browser action。

Runtime 内部必须调用 Engine `classify()`、持久化 attempt 审计、attempt slot 验链/选择和 retry policy；执行器只向 Attempt Authority 的 `appendAttemptEvent()` 提交完整上下文和事件，由 Authority 自行验证状态转换、计算链摘要并签名；使用独立 verifier 验证每个 event proof。需要修订时重新计算 ApprovalSubject 并由 Authority 撤销旧 grant。

## 执行步骤

在运行状态内按页面身份、角色、数据、Gateway、环境、oracle、自动化顺序诊断单次失败；先从落盘 artifact 重算初始链、事件链和 workflowDigest，校验 generation/asset/PRD/run/case 绑定、slot 连续性、started→terminal 顺序、事件时间单调、proof purpose/keyId/signature 与前后摘要。再把每个 terminal 的 status、mode、effect、effectObservation、reservationSafeToVoid 与 `browser-results v2` 精确对齐；`passed|failed` 还必须把 terminal 的 reservationId/outcomeDigest 与 Gateway 签名 reservation 精确对齐；只有 effect-aware retry 规则允许时才生成下一 slot。所有 slot 结束再进入 `diagnosing`，冻结 final attempt、分类、change digest 和 assertionChanged=false，然后请求 `finalizing`。

Target Probe 发生在业务执行前，恢复不属于 Browser action retry：读取上一 attempt 的 reasonCode 与 diagnostics。全部为 `preview-readonly` 时从 `application-ready` 升级到 `dom-identity`，不得重复同一策略；含写 lane 始终保持 `resource-closure`，必须修复环境后再探测。页面脚本异常、origin 漂移、安全边界或页面身份仍不可信时不得降级。每次阻断后必须立即 `get-status`，把当前可行动诊断发布到 `~/.mutil-skills/e2e/runs/<asset>/<run>/run-status.html`，明确标记业务 Case 未执行，不得等待最终报告才告知用户。

## 退出条件

每个 Case 有可复算的唯一 selection、selectedAttemptId、完整 event-chain digest 和分类；运行状态内的允许重试已成功或安全耗尽；`diagnosing` 只退出到 Engine 接受的 `finalizing`。

## 暂停条件

证据不足、effect unknown、业务预期未决，或修改 Action Map/lease/environment 导致重新审批。

## 禁止行为

不得修改 PRD、产品代码、Case 必要性、oracle 或断言强度；Attempt Authority 不得提供任意摘要签名接口；不得跳 slot、删除或重排事件、伪造 terminal event、复用其他 generation/run/case 的 proof，或重试可能已生效的写；不得把 diagnosis 中的选择说明当作权威事实。

## 独立调用

缺少必需 artifact/digest 时，只返回最小缺失项；不得重建上游，不得推进状态。
