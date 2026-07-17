# 验收范围与 Scope Approval

## 适用状态

`source-frozen → awaiting-scope-approval → scope-approved`。

## 必需 Artifact 与摘要

已验签 `prd-manifest`、`prd-diff`（Schema 2.0.0）、`project-policy` 和用户原始验收诉求摘要；
`prd-diff.lineageReview` 的终态必须带专用 Lineage DecisionReceipt。

## 允许的语义输出

纳入/排除候选、歧义、依赖、视觉边界、浏览器范围和版本化 Scope Decision Subject 展示摘要；
标准输出为 `acceptance-scope`（Schema 2.0.0）及专用 DecisionReceipt 引用。

## 调用的确定性 API

Skill 唯一调用固定 launcher `~/.mutil-skills/bin/repo-e2e rpc`，按 JSON stdin/stdout 发送严格 `RuntimeRequestEnvelope` 并解析严格 `RuntimeResponseEnvelope`。成功 `result` 必须拒绝未知字段并包含 `state`、`nextEdge`、`verifiedDigests`、`minimumMissingInput`；决定展示与签名只能通过 Runtime 的 `open-approval` 完成，聊天文本不是审批证明。

Runtime 内部必须调用 Contracts 对六类范围事实做严格 `scope-decision-subject/v1` 投影；该投影明确排除
`scopeDecision` 自身。Runtime 调用独立 Authority，由登记的 `scope-approver` 使用专用 Decision key 签发
`scope-decision-receipt/v1`，再由 Engine 从本代事实重建 subject 并验签。

## 执行步骤

先完成并验证 Lineage DecisionReceipt；按来源列出候选；集中请求具体决定；把答复绑定 decisionId；
Authority 生成 checkedAt 和 nonce 并签发。首次构建与 staging 发布前都重建完整 subject，验证
kind、status、decisionId、subject digest、purpose、key 和签名，成功后进入 `scope-approved`。

## 退出条件

全部影响结论的歧义有签名决定或已排除，范围 artifact 与 PRD Revision 一致；approved/rejected
必须有有效 receipt，pending 必须没有 receipt。
每个 resolved 歧义必须把 `decisionId` 和非空 `resolution` 一并写入 Scope Decision Subject；只记录问题、
状态或通用摘要而没有用户实际答案时不得批准。

## 暂停条件

决定缺失或 pending、审批人角色不符、verifier 缺失、receipt 被篡改或任一范围事实变化；保持
`awaiting-scope-approval`。rejected 进入安全阻断，不得当作批准继续。

## 禁止行为

不得把聊天中的“可以”、通用 Artifact 签名或旧 receipt 当作范围批准；不得先写 approved 再补签名；
不得代用户回答歧义，不得在审批前确定 oracle、Case 或执行动作。

## 独立调用

缺少必需 artifact/digest 时，只返回最小缺失项；不得重建上游，不得推进状态。
