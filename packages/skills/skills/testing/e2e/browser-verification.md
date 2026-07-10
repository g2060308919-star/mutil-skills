# 浏览器验证

## 目的

在确认的执行契约下预检、绑定、编译和执行真实链路与浏览器级故障注入，并收集脱敏证据。

## 触发条件

当执行契约已确认且需要用 Playwright 预检、绑定、执行或采集浏览器证据时使用。

## 必需输入

confirmed execution-contract.json、test-cases.json、coverage-matrix.json 和浏览器运行时能力。

## 可选输入

storageState 引用、Host Browser Server、用户提供的请求协议、已发布 current 回归资产。

## 工作流

预检 URL、登录、角色、页面身份和数据；绑定语义步骤；发现新风险则回流契约；编译 staging；先跑真实链路和健康基线，再跑注入 Case。

## 详细算法

定位器按 role+name、label、placeholder、testid、稳定属性、上下文文本、CSS fallback 排序。每个角色用独立 Browser Context。真实链路禁止 route mock。故障注入只在当前 Context 拦截，并把写请求在到达服务端前 fulfill 或 abort。每个已执行 Case 采集身份截图、关键状态截图、DOM、关键 Network、Console 和视频或 Trace，且脱敏 Authorization、Cookie、token、password、secret 及个人信息。

## 输出

browser-preflight.json、browser-action-map.json、browser-results.json、browser-evidence.json 与 evidence 目录。

## 完成条件

所有可执行 Case 有动作映射、实际结果和完整证据；真实与注入结果分开；新风险均已获得决定。

## 阻塞条件

URL、浏览器、登录、角色、数据或页面身份不可用；发现未声明高风险动作；页面或环境阻断。

## 禁止行为

不得改变 PRD 预期、在真实链路启用 mock、复用角色 Context、泄露秘密或让未授权写请求到达服务器。

## 独立使用示例

先确认目标 heading 和表格存在，再用 getByRole 绑定城市下拉；对查询接口 route fulfill 500 并验证前端错误提示。
