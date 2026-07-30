# 覆盖 Universe、Case 与设计审计

## 适用状态

`modeled → coverage-audited`。

## 必需 Artifact 与摘要

`requirement-model`、`interaction-flow`、`acceptance-scope` 及相互 dependency digest。

## 允许的语义输出

Coverage obligation、disposition 候选、原子 Case、manual procedure 候选和 N/A 理由。

## 调用的确定性 API

Skill 唯一调用固定 launcher `~/.mutil-skills/bin/repo-e2e rpc`，按 JSON stdin/stdout 发送严格 `RuntimeRequestEnvelope` 并解析严格 `RuntimeResponseEnvelope`。每个业务命令成功后必须立即调用 `get-status`；只有严格拒绝未知字段的 `get-status` `result` 才提供 `state`、`nextEdge`、`verifiedDigests`、`minimumMissingInput`，其他命令结果不得用于猜测状态；设计审计、覆盖闭包和状态转换均由 Runtime 内部完成。

Runtime 内部必须调用 Engine 构造/审计 Universe、`auditDesign()` 和 `transition()`；覆盖率、集合闭包和 100% 判断只读取 Runtime 返回的 Engine 输出。

## 执行步骤

为 Clause、需求、规则、Oracle、关键节点、角色、状态转换和场景类别建立 obligation；每个 obligation 显式冻结 `clauseIds`、`ruleIds`、`oracleIds`，并逐项选择 automated/manual-required/not-applicable/input-blocked disposition。每个 not-applicable 必须由登记的 `coverage-approver` 签发专用 Coverage Disposition DecisionReceipt，精确绑定 obligation、模型摘要、覆盖策略摘要、policyCode 与 rationale；不得把任意字符串当审批证明。随后生成不含 locator 的 Case并运行设计审计。

## 退出条件

`coverage-universe`、`test-cases`、`design-audit` 全部通过 Schema；全部 modeled Clause、Rule、Oracle 都恰好进入可追踪 obligation，必要闭包无 orphan/weak Case，Engine 接受 `coverage-audited`。

## 暂停条件

obligation 无处置、N/A 无冻结策略、Case 缺 oracle 或设计审计存在 error。

## 禁止行为

不得手算覆盖率、复制 Case 凑数量、用 skip 处置 blocked 项、在 Case 中写 selector 或因难自动化而降级必要性。

## 独立调用

缺少必需 artifact/digest 时，只返回最小缺失项；不得重建上游，不得推进状态。
