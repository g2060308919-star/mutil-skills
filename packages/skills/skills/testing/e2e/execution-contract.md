# 执行契约

## 目的

集中处理环境、身份、数据、Case 队列、故障注入与高风险动作，并完成唯一的第二次用户确认。

## 必需输入

test-cases.json、design-audit.json、baseUrl 或待补 URL、环境信息和测试工作区。

## 可选输入

storageState 引用、人工登录会话、测试数据来源、已授权 API 协议和清理规则。

## 工作流

分类真实与注入 Case，收集身份和数据需要，逐项评估风险和注入安全性，列出未决输入，再集中请求确认。

## 详细算法

未知环境必须询问。生产环境默认只读；每个写或不可逆动作记录影响、外部副作用、可恢复性和 allow、avoid、deny 建议。pending 高危动作会阻断全部执行，只有明确 rejected 或 cancelled 才能转为 not-executed-user-declined。approved-api 只接受用户提供的协议、授权和清理规则。

## 输出

execution-contract.json，含 identities、dataRequirements、realCaseIds、faultInjectionCaseIds、highRiskActions、faultInjectionRules 与 confirmation。

## 完成条件

环境、URL、身份、数据、Case 队列、故障注入和每项风险已明确，confirmation 为 confirmed。

## 阻塞条件

URL、环境、登录态、权限、数据或高风险决定缺失，或第二次确认尚未完成。

## 禁止行为

未完成执行契约确认不得执行任何 Case；不得从 Network 猜测 API 造数据，不得在生产自动执行不可逆动作。

## 独立使用示例

在 staging 中将查询 Case 列为 real，将 500 Case 列为 fault injection，并要求用户分别批准审核写操作。

