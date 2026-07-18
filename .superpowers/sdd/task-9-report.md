# Task 9 实施与审批报告

日期：2026-07-18
结论：**批准 Task 9 代码完成。生产写入、注入分域、崩溃恢复与资源终态均已接入可安装 Runtime。**

## 已完成

- 声明式可逆写严格执行 freshness、Grant、Lease、Gateway reservation、浏览器动作、Outcome、complete/unknown、验证、cleanup 与 Lease 终态。
- Secret 仅以 opaque handle 在动作临界点消费，不进入 Action、日志、trace、Gateway audit 或持久 Run state。
- real-environment 与 gateway-injection 使用独立 result identity、Gateway session 与持久化域；注入没有上游写规则，不能替代真实结果或计入真实通过率。
- write response 断连等 effect-unknown 永久禁止自动重试：reservation 转为 unknown、Lease 隔离，恢复流程不会再次执行浏览器动作。
- RuntimeRecoveryCoordinator 已由真实 CLI 默认装配，覆盖持久 owned-resource registry、Authority reservation/Lease、Artifact transaction、frozen generation 与 workflow edge 恢复。
- Lease release 前持久化 cleanup checkpoint；release 成功但终态回执未落盘时可从 Authority 查询并复用回执。checkpoint 缺失或不一致时 fail closed。
- expired/revoked Grant 仅能激活 recovery-only registration；恢复白名单只允许查询/unknown/quarantine，禁止 reserve、complete、release、verify 或新执行。
- 安装恢复会清理 Runtime 所有的浏览器 profile、Gateway/Authority 子进程、事务临时目录与过期资源；任何归属或证据不闭合都失败关闭。
- HTTP/HTTPS、逐跳 redirect 与 Beacon 受签名 Gateway policy 约束；WebSocket/SSE 首发维持 fail-closed，不宣称消息级支持。

## 验证

- `npm test -- --reporter=dot`：159 个文件通过、1 个跳过；1266 项通过、27 项按环境或能力边界跳过。
- `npm run e2e:golden`：10 个文件、24 项通过；3 项因未配置受信任 Real Golden Home 跳过。
- Authority Host 与真实 loopback Gateway 定向回归：23/23 通过。
- `npm run typecheck`、`npm run build`、`npm run lint:architecture`、`git diff --check`：通过。

## 保留边界

- 首发不支持 WebSocket/SSE 消息级受控执行；匹配到 WebSocket capability 时返回固定 unsupported，未授权或重复请求返回拒绝。
- 默认 Authority 保护级别为 `local-crash-integrity`，不宣称抵抗已完全控制当前 OS 用户或 root 的整体回滚；只有独立可信 provider 才能声明 `trusted-monotonic`。
