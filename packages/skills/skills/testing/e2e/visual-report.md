# 验收报告

## 目的

仅消费 Schema 已验证的结构化事实，渲染最终 JSON、Markdown 和静态 HTML，并给出严格结论。

## 触发条件

当结构化执行和证据产物齐备，且需要生成最终验收报告或解释严格结论时使用。

## 必需输入

acceptance-scope.json、coverage-matrix.json、test-cases.json、browser-results.json、browser-evidence.json、diagnosis.json、regression-manifest.json 和 execution-contract.json。

## 可选输入

interaction-flow.json、design-audit.json 和附加的已脱敏证据。

## 独立调用守则

独立调用时，缺少任一上述命名输入，明确列出缺失的文件或信息并请求用户提供；返回 blocked，不得推断、重建、补写或执行任何上游阶段。

## 工作流

校验输入完整性，计算指标和 strict verdict，生成 final-report.json，再渲染 Markdown 与无 CDN 的静态 HTML，最后审计 latest 发布条件。

## 详细算法

报告按结论和不能宣称内容、PRD/环境/角色、指标、范围、覆盖、流程、Case、真实结果、注入结果、健康基线、诊断、拒绝和阻塞、回归更新、风险和下一步排序。accepted 仅在所有必要 Case 已执行并通过、证据完整、无歧义和关键拒绝时成立；业务不符合为 rejected，其余按 incomplete、pending-decision、environment-blocked 或 automation-blocked。评分不得推翻严格状态。

## 输出

final-report.json、report.md、report.html 和准备发布的 latest 目录。

## 完成条件

每个已执行 Case 有步骤、预期、实际和证据，结论可由输入事实复算，HTML 可离线查看、筛选 Case 并安全 escape 文本。

## 阻塞条件

结构化输入缺失或不合法、证据不完整、Case 数量不一致、结论无法由严格规则确定。

## 禁止行为

不得补写测试事实、混合真实与注入结论、隐瞒拒绝或阻塞、把高通过率当作 accepted，或使用在线 CDN。

## 独立使用示例

10 个已执行 Case 全通过但另有 10 个必要 Case 被拒绝时，报告 executionCoverage 50% 且 verdict 为 incomplete。
