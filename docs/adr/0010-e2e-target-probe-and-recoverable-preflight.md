# ADR 0010：Target Probe、验收语义确认与可恢复预检

- 状态：Accepted
- 日期：2026-08-02

## 背景

0.4.5 的跨机器验证暴露出三个被错误耦合的问题：目标环境由 Policy、Run 和 Discovery 分别描述；页面身份只依赖标题启发式；预检阻断直接把 Run 推入不可恢复终态。结果是 localhost 在 shell 中不可达但浏览器可达时被误判，普通业务卡片无法作为身份，修复 selector 后还必须重建 Run 并重复需求建模和审批。

同时，调用者看不到 Runtime 对 PRD 原文、交互、验收范围和 Case 的实际理解，容易在浏览器执行之后才发现语义偏差。

## 决策

1. Runtime 生成唯一 `TargetContractFact`。目标 URL、环境标签、页面身份和允许来源只由该事实派生，后续阶段引用其摘要。
2. 浏览器侧 `Target Probe` 是非权威诊断，不进入 Verdict。它使用与正式链路相同的系统 Chrome、一次性 Profile 和 Gateway。Runtime 按执行 lane 和同一 Run 的历史结果选择 `resource-closure`、`application-ready`、`dom-identity` 三档策略；全部为 preview-readonly 时以应用就绪为首选，安全重试升级为 DOM identity；含写 lane 始终保持严格资源闭包，不能降级。SPA HTTP 资源仍采用最多 5 轮、256 项的显式来源 GET/HEAD 精确 URL 闭包发现。写请求、非显式来源和任意页面动作仍被拒绝；WebSocket/SSE/HMR 只作为长期连接诊断，不会自动扩张 Gateway 权限。
3. 页面身份改为声明式 `PageIdentityPolicy`，支持 test-id、ARIA、受限 CSS、可见文本、title 和 heading；URL 与至少一个业务信号共同构成身份。
4. Runtime 从冻结来源与 PRDRunCompiler 结果生成含真实语义目录的 `AcceptanceReview`。无副作用 Target Probe 先于确认，以便尽早发现错址；Discovery 授权和可信预检前必须确认 reviewDigest。可信预检形成最终 Binding 后，Execution Approval 只展示 Target、Binding、Action、网络、副作用、Fixture 和 Cleanup 差异。
5. Run 的流程位置与阻断条件分离。全部为 `preview-readonly` 且原因为页面暂未就绪、资源闭包、真正 pending 或预期长期连接时保存为 `blocked-retryable`；页面暂未就绪维持 application-ready，资源类阻断才升级策略。页面身份不匹配、pageerror、导航错误和含写 lane 的阻断均为 `blocked-requires-change`。修复后仍在同一 Run 继续；修改页面身份会推进 revision，只失效 Target Probe、Discovery、Preflight 和下游执行事实，保留冻结 PRD 和语义资产。
6. 所有高层操作使用 `RunHandle`。Runtime 继续保留严格 RPC 作为底层兼容协议，Skill 和友好 CLI 只做参数适配与状态投影，不复制权威状态机。
7. Probe 在返回前冻结最小诊断快照：URL/title、DOM 是否存在、可见文本摘要、Console/pageerror、失败请求、真正未结束的请求、尚未获批的新 URL、长期连接、资源计数、策略与 attempt。每次业务命令后的 `get-status` 将该事实发布为 JSON、Markdown 和 HTML 中间报告，并明确业务 Case 是否执行。
8. 同一 Case 内相同 `contractNodeId + acceptanceCriterion` 的重复 Oracle 被编译器拒绝；跨 Case 的多种验证可以保留，但 `mappedAcceptanceCount` 只统计唯一验收标准，`oracleCount` 单独统计 Oracle 总数。

## 安全边界

- Probe 的浏览器事实不能冒充 BrowserPreflight、Evidence 或 Verdict。
- effect unknown、真实写、Cleanup 失败和安全阻断不能通过通用 retry 重放。
- 页面身份变化必须使旧执行批准失效；Requirement/Rule/Oracle 本身不因 selector 修订而重建。
- 本地确认不提升身份保证，报告固定保留 `identityVerified=false` 与 `separationOfDutiesVerified=false`。
- Probe 资源发现只把浏览器实际请求投影为下一轮精确规则，不产生来源 wildcard，也不批准 POST/PUT/PATCH/DELETE。
- `application-ready` 与 `dom-identity` 只改变非权威 Probe 的结束条件，不替代写操作的可信 BrowserPreflight、Authority、Gateway、DataLease 或 Cleanup 门。
- 页面脚本异常、origin 漂移或页面身份不可信不能通过策略升级变成 ready。

## 结果

用户可以在执行前看到 PRD 到 Case 的完整理解；localhost 以受控浏览器的实际可达性为准；SPA 非标题页面可以使用稳定业务 DOM 身份；HMR、轮询或长期连接不再阻断合法只读验收；页面身份修正后复用同一 Run 和语义资产。代价是 SPA Probe 最多启动多轮短生命周期浏览器/Profile，诊断耗时会上升，非严格策略可能在后台资源仍变化时结束非权威探测，但写执行安全门没有降低。

## 验证

- Contracts、Runtime Host、Installer、Facade、Report 与 Skill 回归测试。
- 真实 localhost SPA Golden：正式 Gateway、系统 Chrome、静态脚本、持续产生新轮询 URL 的开发态页面、错误 test-id 与修订后的正确 test-id；Runtime Host 恢复测试独立证明同一 Run 修订、语义资产保留、策略升级与下游失效矩阵。
- 完整 full-playwright Golden：表单、Popup、多页面、JSON Body 写请求、截图、Trace、Cleanup 与 Reload。
- Release pack Golden：全新 HOME 安装正式 tarball 闭包并以零条件跳过完成完整链路。
