# 需求模型

## 目的

将已确认范围中的每个 REQ 转成可追溯、可观察的业务和交互规则。

## 必需输入

confirmed acceptance-scope.json、normalized-prd.md 和 prd-manifest.json。

## 可选输入

用户确认的补充规则、被引用设计或交互规范。

## 工作流

逐个 REQ 提取 actor、前置条件、RULE、状态、转换、UI 与 Network 可观察结果，再校验来源和确定性。

## 详细算法

每条 RULE 标注业务、权限、校验、状态、错误或视觉类别，并记录 PRD、用户确认、引用规范或推断来源。推断必须标为 pending，不能形成确定性断言。每个转换都有 from、action、to 与允许角色；只保留浏览器可观察的结果。

## 输出

requirement-model.json，含 REQ、RULE、actor、状态、转换和 observable outcomes。

## 完成条件

全部 RULE 有来源，所有确定性断言已确认，状态转换完整且均可在浏览器中观察。

## 阻塞条件

范围未确认、关键规则缺来源、推断未确认，或预期无法通过浏览器观察。

## 禁止行为

不得用页面当前行为补写规则、创建定位器、执行浏览器，或把 pending inference 当作 PRD 事实。

## 独立使用示例

将城市筛选拆为筛选规则、空态规则和请求结果可观察项，并分别关联 REQ-ID 与 RULE-ID。

