# 覆盖矩阵与测试 Case

## 目的

将需求、规则、流程和关键节点映射为可独立诊断的浏览器 Case，并以设计审计锁定完整性。

## 必需输入

requirement-model.json、interaction-flow.json 和 confirmed acceptance-scope.json。

## 可选输入

已确认的风险优先级、组合归并理由。

## 工作流

生成覆盖项，设计 Case，关联 REQ/RULE/FLOW/NODE，执行设计审计；未达硬门时回流模型或流程。

## 详细算法

覆盖正常、校验、权限、状态转换、空态、接口错误、网络错误、超时、边界、恢复和韧性场景。每个 Case 有稳定 CASE-ID、目的、前置、数据要求、独立步骤、预期、证据类型、执行方式和风险。要求 included REQ→coverage→CASE、RULE→coverage→CASE、关键 NODE→CASE step，且需求、规则和关键节点设计覆盖均为 100%。

## 输出

coverage-matrix.json、test-cases.json 和 design-audit.json。

## 完成条件

审计无 error finding，无 orphan 或 weak Case，三个硬覆盖指标均为 100%。

## 阻塞条件

上游模型或流程不完整、关键场景没有来源、审计未通过，或预期仍未确认。

## 禁止行为

不得写没有预期或覆盖项的 Case、把多个失败原因混在一个 Case、复制同逻辑凑数量、写死一次性数据 ID 或在设计阶段写 Selector。

## 独立使用示例

为列表筛选创建真实链路 Case，为接口 500 创建 fault-injection Case，并分别关联同一规则的不同 coverage item。
