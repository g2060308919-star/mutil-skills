# 需求、规则、Oracle 与交互流程

## 适用状态

`scope-approved → modeled`。

## 必需 Artifact 与摘要

已验签 `acceptance-scope`、`prd-manifest`，以及其冻结的 Scope Approval digest。

## 允许的语义输出

REQ/RULE、actor、state/transition、可观察 oracle、interaction flow、Rule→Oracle 显式引用和明确标记的 inference 候选。

## 调用的确定性 API

Skill 唯一调用固定 launcher `~/.mutil-skills/bin/repo-e2e rpc`，按 JSON stdin/stdout 发送严格 `RuntimeRequestEnvelope` 并解析严格 `RuntimeResponseEnvelope`。每个业务命令成功后必须立即调用 `get-status`；只有严格拒绝未知字段的 `get-status` `result` 才提供 `state`、`nextEdge`、`verifiedDigests`、`minimumMissingInput`，其他命令结果不得用于猜测状态；稳定 ID、来源闭包、Schema 与状态转换均由 Runtime 内部完成。

Runtime 内部必须调用 Contracts 校验 `requirement-model`/`interaction-flow`，并调用 Engine 分配稳定 ID、验证来源闭包及执行 `transition()`。

## 执行步骤

逐个纳入需求建立来源；把规则转成浏览器可观察的 UI/network/state oracle，并在 Rule 的 `oracleIds` 中显式列出对应 Oracle。旧资产没有 `oracleIds` 时只能标记为 `requirement-level` 关联，不得伪装成精确映射；建立入口、分支、错误、恢复和终点；把未确认推断保留为 pending。

## 退出条件

每个 REQ/RULE/oracle/flow 均有来源与稳定 ID，每条 Rule 至少显式引用一个同 Requirement 的 Oracle，所有确定性预期来自 PRD 或签名决定。

## 暂停条件

关键预期无来源、无法观察或新歧义改变 Scope Approval subject。

## 禁止行为

不得读取当前页面来定义 expected，不得绑定 locator，不得把 inference 当事实，不得自行产生稳定摘要。

## 独立调用

缺少必需 artifact/digest 时，只返回最小缺失项；不得重建上游，不得推进状态。
