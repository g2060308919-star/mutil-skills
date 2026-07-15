# Safety Gateway 与出站强制边界

## 适用状态

`execution-approved` 至运行结束；真实和注入阶段分别安装不可变 policy。

## 必需 Artifact 与摘要

已验签 v2 `run-bundle`、v2 `approval-grants` freshness receipt、v2 Action Map、DataLease、origin policy 和 Gateway 受信公钥摘要；receipt 必须在发布前动态复验当前 Authority 状态。

## 允许的语义输出

缺失 intent、matcher 冲突、阶段切换请求和安全阻断说明；标准事实为签名 `gateway-audit`。

## 调用的确定性 API

调用独立 Gateway install/reserve/forward-or-inject/finalize API；canonical URL、nonce 消费、计数和签名由 Contracts/Gateway 完成。可恢复写 finalize 必须由 Gateway 从自身持有的 reservation、完整 Capability/批准请求集合和独立 executionSessionId 计数派生事实，签发专用 `ExecutionOutcomeReceipt`；不得接受 Runner 自报 opaque outcomeDigest 或只落一个不可复算的 request-set digest。

## 执行步骤

强制 Chromium 仅连接 Egress Guard；安装 bootstrap 白名单；页面 ready 后原子切 case policy；对每个请求验签 capability、effect、attempt、lease 和顺序；全部 capability 必须与 approval receipt、Action Map、Run Bundle 和 reservation 一致；结束时取得签名计数。Gateway 对 Authority 的动态验签、reservation CAS 和 completed/unknown 终态回写必须调用固定的认证 RPC operation；客户端固定 Authority 公钥摘要，并复核返回 reservation 的 grant/capability/action/attempt/context，不能只凭 HTTP 成功状态继续转发。写动作还必须把 Gateway 签名结果回执交给受控 bridge 和独立 Playwright 子进程复验，并以唯一 actionId 保存到 `browser-results.executionOutcomeReceipts[]`。

## 退出条件

所有请求均有 allow/deny/inject 审计，真实模式注入数为零，注入目标 upstream mutation 为零且签名计数闭合。

## 暂停条件

Gateway/CA/DNS/代理不可用、未知 origin/protocol、签名或撤销状态异常、reservation 为 unknown。

## 禁止行为

不得用 `page.route()` 作为正式安全或注入边界，不得允许 QUIC/UDP/直连逃逸，不得用 glob/regex 扩大 intent，也不得用通用 Artifact 签名、过期 receipt 或单个合成 capability 代替 Authority/Gateway 的完整证明。

## 独立调用

缺少必需 artifact/digest 时，只返回最小缺失项；不得重建上游，不得推进状态。
