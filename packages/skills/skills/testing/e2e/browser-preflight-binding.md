# 只读预检与动作绑定

## 适用状态

`discovery-approved → preflight-readonly → binding-draft`。

## 必需 Artifact 与摘要

DiscoveryCapability、`test-cases`、`execution-contract`、环境/origin、角色 secret refs 和 project policy digest。

## 允许的语义输出

页面身份观察、locator/action/oracle/effect 候选、输入阻塞事实；标准输出为 `browser-preflight` 与 `browser-action-map`。

## 调用的确定性 API

Skill 唯一调用固定 launcher `~/.mutil-skills/bin/repo-e2e rpc`，按 JSON stdin/stdout 发送严格 `RuntimeRequestEnvelope` 并解析严格 `RuntimeResponseEnvelope`。成功 `result` 必须拒绝未知字段并包含 `state`、`nextEdge`、`verifiedDigests`、`minimumMissingInput`；受控 Chromium、Gateway 与状态机均由 Runtime 内部调用。

Runtime 内部必须调用受控 Chromium 的只读 preflight/binding API、Gateway bootstrap policy、Contracts parse 和 Engine `transition()`。

## 执行步骤

验证 URL/TLS/origin、登录和角色信号、页面身份、关键控件、数据、Gateway、证据目录和 Chromium sandbox；按 role/name、label、testid、稳定属性绑定；冻结 Action Map。

## 退出条件

页面/角色/数据身份可信，每个 Case step 有唯一动作与 oracle，effect 分类无降级，Engine 接受 `binding-draft`。

## 暂停条件

页面、角色、数据、浏览器或网关不可用时进入 `input-blocked`/`environment-blocked`，保存 `preflight-readonly` resumeState。

## 禁止行为

DiscoveryCapability 下不得执行 Case、业务搜索、提交、下载、未知 GET 或写入；不得只靠单一文本判断页面身份。

## 独立调用

缺少必需 artifact/digest 时，只返回最小缺失项；不得重建上游，不得推进状态。
