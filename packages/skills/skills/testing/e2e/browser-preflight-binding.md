# 只读预检与动作绑定

## 适用状态

`discovery-approved → preflight-readonly → binding-draft`。

## 必需 Artifact 与摘要

已确认 AcceptanceReview、`TargetContract`、已完成的无副作用 `Target Probe`、DiscoveryCapability、`test-cases`、`execution-contract`、环境/origin、角色 secret refs 和 project policy digest。TargetContract 固定唯一 target URL、base origin、environment label、允许导航 origin 与页面身份策略。

## 允许的语义输出

页面身份观察、locator/action/oracle/effect 候选、输入阻塞事实；标准输出为非权威 Target Probe、`browser-preflight` 与 `browser-action-map`。页面身份策略支持 `test-id`、`role`、受限 `css-visible`、`visible-text`、`title` 与 `heading`；除 URL 外至少使用一个稳定业务信号，文本和标题只作辅助，不把 h1/h2/h3 当成唯一页面身份。

## 调用的确定性 API

Skill 唯一调用固定 launcher `~/.mutil-skills/bin/repo-e2e rpc`，按 JSON stdin/stdout 发送严格 `RuntimeRequestEnvelope` 并解析严格 `RuntimeResponseEnvelope`。每个业务命令成功后必须立即调用 `get-status`；只有严格拒绝未知字段的 `get-status` `result` 才提供 `state`、`nextEdge`、`verifiedDigests`、`minimumMissingInput`，其他命令结果不得用于猜测状态；受控 Chromium、Gateway 与状态机均由 Runtime 内部调用。

Runtime 内部必须调用系统 Chrome 或显式托管 Chromium 的一次性 Profile、只读 Target Probe/preflight/binding API、Gateway bootstrap policy、Contracts parse 和 Engine `transition()`。命令行无法访问 localhost 不能判定目标不可用；CLI shell 与受控浏览器网络环境可能不同，只以浏览器侧 Target Probe 的 observed URL、title、identity evaluation 和 Gateway 诊断决定可达性。

## 执行步骤

1. 在任何 Discovery 授权或浏览器预检前，先展示并确认 AcceptanceReview；确认前不得打开目标或推导 locator。
2. 配置 TargetContract。优先选择产品稳定 `data-testid`、ARIA role/name 或不含通配逃逸的业务 CSS；URL path pattern 与强业务信号共同构成身份，不使用动态文案作为唯一强信号。
3. 运行 Target Probe。它只允许目标入口的无副作用导航和页面身份读取，不执行 Case。若页面不匹配，向用户展示每个 signal 的 expected/observed/matched，而不是笼统返回 mismatch。
4. Discovery 授权后验证 URL/TLS/origin、登录和角色信号、页面身份、关键控件、数据、Gateway、证据目录和浏览器 sandbox；按 role/name、label、test-id、稳定属性绑定；冻结 Action Map。
5. 服务未启动、临时 loading 或相同策略下的环境阻断使用 `retry --run` 原地重试。若 `E2E_RUNTIME_PAGE_MISMATCH` 证明身份策略本身错误，用新的 TargetContract 修订同一 Run；Runtime 必须增加 revision，回到 Discovery 前，返回 `preservedAssets` 与 `invalidatedAssets`，保留 PRD/Requirement/Rule/Oracle/Case，失效旧 Target Probe、Discovery Grant、preflight 和浏览器绑定，再重新 Probe 与授权。

## 退出条件

Target Probe 与 TargetContract digest 闭合，页面/角色/数据身份可信，每个 Case step 有唯一动作与 oracle，effect 分类无降级，Engine 接受 `binding-draft`。同一 Run 修订后，状态视图能明确列出保留和失效资产，不混用旧 Run、旧 requestId 或旧脚本。

## 暂停条件

页面、角色、数据、浏览器或网关不可用时进入可恢复的 `input-blocked`/`environment-blocked`，保存 `preflight-readonly` resumeState、reasonCode、attemptCount 与 remediation。安全边界失败仍进入不可自动恢复终态；不得把环境阻断、未执行和业务断言失败混为一个 failed。

## 禁止行为

DiscoveryCapability 下不得执行 Case、业务搜索、提交、下载、未知 GET 或写入；不得只靠单一文本判断页面身份；不得用 shell curl 失败推翻浏览器探测；不得在变更 TargetContract 后复用旧 Grant、旧 preflight 或旧 binding；不得为修复选择器重建需求资产或新建 Run。

## 独立调用

缺少必需 artifact/digest 时，只返回最小缺失项；不得重建上游，不得推进状态。
