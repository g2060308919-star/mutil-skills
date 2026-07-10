---
name: e2e
description: 根据 PRD 设计、执行并沉淀 Playwright 浏览器验收与回归资产。用于用户提供 PRD、测试地址或测试工作区，并要求 E2E 验收、浏览器验证、故障注入、回归测试或证据报告时；先确认验收范围和执行契约，再执行浏览器验证。
---

# PRD 驱动 E2E 浏览器验收

将 PRD、用户确认和真实浏览器证据串成可审计的验收闭环。此 Skill 只编排和审计流程；浏览器、Schema、回归编译与报告工具必须由宿主已有能力提供。工具不可用时阻塞并说明缺失项，绝不伪造结果。

## 输入

接收产品空间、PRD 正文或已规范化内容、用户验收诉求、测试工作区，以及可选的 URL、环境、登录态引用和数据说明。不得接收或记录密码、Cookie、Token 等秘密本身；只接收环境变量名、storageState 路径或人工登录会话引用。

## 产物与状态

将业务资产保存在 testWorkspace/.biztest 下：requirements/<prd-id> 保存当前需求设计，regression/<prd-id>/current 保存标准 Playwright 回归资产，tasks/<prd-id>/latest 保存最近一次完整执行的证据和报告。所有 JSON 先经 Schema 校验，再以 staging、校验、切换和回滚发布。

按以下状态机推进：draft → awaiting-scope-confirmation → designing → design-audit → awaiting-execution-confirmation → preflight → binding → compiling → running-real → running-fault-injection → diagnosing → self-healing → finalizing → accepted、rejected、incomplete、pending-decision、environment-blocked 或 automation-blocked。不得跳过节点或在浏览器执行后回填上游产物。

## 调度流程

| 节点 | 读取子流程 | 仅在满足条件后进入下一节点 |
| --- | --- | --- |
| PRD 接入 | [prd-intake.md](prd-intake.md) | PRD-ID、Revision 与来源已确定 |
| 验收范围 | [acceptance-scope.md](acceptance-scope.md) | 用户首次确认完成 |
| 需求建模 | [requirement-model.md](requirement-model.md) | 每条确定规则可观察且可追溯 |
| 交互流程 | [interaction-flow.md](interaction-flow.md) | 主链、分支与风险已建模 |
| 覆盖和 Case | [coverage-cases.md](coverage-cases.md) | 设计审计需求、规则、关键节点均为 100% |
| 执行契约 | [execution-contract.md](execution-contract.md) | 用户第二次确认完成 |
| 浏览器验证 | [browser-verification.md](browser-verification.md) | 预检、绑定、真实链路和故障注入已结构化记录 |
| 自动化诊断 | [automation-healing.md](automation-healing.md) | 失败已分类且安全重试已耗尽或成功 |
| 回归资产 | [regression-assets.md](regression-assets.md) | current 与 manifest 已通过质量门 |
| 视觉报告 | [visual-report.md](visual-report.md) | final report、Markdown 和 HTML 已生成 |
| 产物协议 | [artifact-protocol.md](artifact-protocol.md) | 任意读写前后均执行其安全规则 |

## 两个确认门

未完成验收范围确认，不得生成确定性需求模型、覆盖矩阵或 Case。集中展示纳入项、排除项、影响结论的歧义、依赖和视觉边界；只有 confirmed 且每个影响结论的歧义均已回答或排除后才继续。

未完成执行契约确认，不得执行任何浏览器 Case，包括只读 Case。集中展示环境、URL、角色、登录态、数据、真实链路、故障注入及每项高风险动作。执行中发现新的写或不可逆动作时，暂停全部任务，更新契约并重新确认。

## 不可协商的安全规则

生产环境默认只读。写动作必须逐项明确授权；删除、支付、发券、通知和不可恢复审核等不可逆动作默认拒绝。故障注入必须在当前 Browser Context 拦截，写请求必须在到达真实服务端前 fulfill 或 abort。

真实链路和故障注入分别统计和报告。当前页面只能证明实际结果，不能改写 PRD 预期。没有视觉规范时，不判断颜色、间距、尺寸或像素级正确性。不得通过弱化断言、删除 Case、skip、改写 PRD 或修改产品代码让测试变绿。

## 结论与暂停

缺 URL、账号、权限、数据、页面身份或运行时能力时，索取最小必要输入并从阻塞节点恢复，不判定业务失败。最终 accepted 仅在所有必要 Case 通过、证据完整、无未决歧义和关键拒绝项时成立；任何明确业务不符合 PRD 为 rejected，其余未完成情形按严格状态报告且说明不能宣称的内容。
