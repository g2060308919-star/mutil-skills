# ADR 0019：Browser Executor Protocol 成为生产默认路由

## 状态

Accepted，2026-08-09。经用户明确批准完成 Verification Harness 收口；本 ADR supersede ADR 0013 的迁移路由默认值与仓库内 B2B proof 适配边界，其余安全决定继续有效。

## 背景

ADR 0013 在协议迁移初期要求 `legacy` 默认，并只开放 read shadow。此后 Probe、Preflight、Read、Reversible Write、Injection 与 Full Playwright 已全部完成协议适配、单次 dispatch 语义比较、未知写 reconcile、Case 调度以及系统 Chrome Golden。继续让生产 Host 默认绕过协议，会使能力发现、进度、证据引用和恢复语言保持半交付状态。

## 决策

1. Runtime Host 的 read、write、injection 与 full-playwright 默认路由改为 `protocol`；`legacy` 只作为显式回滚开关，`shadow` 继续只执行一次 backend 并 fail-closed 比较完整语义。
2. 协议 dispatch 后仍返回既有严格 Runtime 输出类型供 Host 持久化；协议结果负责统一验证和投影，不新增第二份权威业务结果，Verdict 仍由 Engine 计算。
3. 持久化 Evidence reference 必须通过严格 kind、受控 scheme/authority/规范路径和 digest 校验，禁止网络、宿主文件、query、userinfo、编码分隔符与路径穿越；当前 Full Playwright 明确投影 Trace 以及 runner 已持久化的引用。Screenshot/DOM 原始 bytes 仍先进入 Quarantine，URL、Network、Console 仍由既有证据/审计资产承载，不得在协议文档中误称均已成为 URI reference。仓库 B2B proof 的全部证据 bytes 必须进入同一 active generation，并在发布后回读验摘要。
4. 仓库 B2B proof 可使用不从 package root 导出的专用品牌 capability。Executor adapter 与最终 Runtime-chain proof 分别以独立 WeakMap 闭合，伪造对象必须拒绝；它们不能被 Runtime Host 或用户项目当成生产能力。
5. B2B proof 的 Scheduler、Attempt Authority、Gateway 与 Browser Executor 状态必须由终态 Case/Attempt 绑定、可验签 Attempt 事件、含已消费终态 Authority reservation 且经公钥验签的 Gateway publication，以及带 Screenshot/DOM/Trace 引用的协议结果交叉推导，不接受调用者传入四个成功布尔值。每轮 repetition 必须使用独立 Run 与 Gateway，Gateway 的签名 reservation 必须精确绑定同一 Run、Case、Action、Attempt 与 outcome；Authority 和 Gateway terminal outcome 必须包含并可由 Browser Executor outcome digest 复算，禁止相同身份下拼接另一份结果；四段事实都必须与无重复的期望集合完全相等且不得夹带或重复；所有完整正向轮次 Verdict 均须进入发布摘要与 active generation，不能只发布首轮代表值。

## 验证门

- 协议路由的 legacy/shadow/protocol 契约测试全绿；
- Trace reference 在协议投影、严格执行批次、恢复和跨仓安装 Golden 中不丢失；
- B2B proof 任一 Runtime 链路不完整即失败；
- 全新 HOME 的 workspace tarball Golden 零跳过并通过 full-playwright、Cleanup 与 Reload。

## 回滚

显式把四类路由设置为 `legacy` 可回滚协议默认值，不修改历史 Run、Case、Verdict 或 Artifact。不得删除已持久化 Evidence reference 字段；旧 Runtime 解析兼容仍由版本绑定和迁移策略控制。
