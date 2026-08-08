# ADR 0016：本地 Runtime 选择必须以 installation digest 原子绑定 Run

## 状态

Accepted，2026-08-08。

## 背景

固定 launcher 通过 `current` 选择新进程入口，但 `current` 是可移动的机器默认值，不能充当 Run 的长期执行身份。若 Resolver 只返回版本后释放安装锁、调用方再创建 Run，卸载或 GC 可以在两步之间删除刚选中的 closure；若恢复旧 Run 时重新读取 `current` 或用户新策略，同一 Run 也可能跨版本继续执行。

Phase 5 只验证无网络版本选择模型，不引入在线更新、签名清单或 installer 重写。

## 决策

1. 新 Run 的本地策略只允许 `offline` 和精确 `pinned`。`offline` 选择并完整验证 current；`pinned` 选择并完整验证精确 SemVer 目录及可选 installation digest。两者均不移动 current。
2. 已有 Run 的原始 installation digest 高于所有新 Run 策略；Resolver 必须在已安装 closure 中按摘要定位，缺失、篡改或摘要歧义时 fail-closed。
3. Runtime identity 是 manifest 的 installation digest，不是版本字符串、路径或 current pointer。Run 同时记录版本仅用于展示与诊断。
4. `withResolvedRuntimeInstallation` 在安装锁内完成验证和选择，并要求调用方在回调返回前持久化 Run 绑定。普通 `resolveRuntimeInstallation` 仅适合无状态检查；创建 Run 不得采用“先 resolve、后 bind”。
5. 卸载和未来 GC 在同一安装锁内读取 Run Store 的非终态引用；任何活跃 Run 绑定目标摘要时必须拒绝删除。终态 Run 不再形成运行时保留引用，其证据与报告生命周期由 Artifact retention 管理。
6. Resolver 不联网、不安装、不修改 launcher/current，也不接受 `stable`、`latest` 或 SemVer range。在线信任、LKG 与自动更新仍由 Phase 6 的独立审批 ADR 决定。

## 后果

- 同一 Run 的执行版本可追踪且不会因机器默认值变化而漂移。
- 新 Run 的选择与 durable binding 之间不存在可被卸载插入的窗口。
- 活跃 Run 可能延迟旧 Runtime 清理；运维需要先让 Run 进入终态或显式处理其恢复状态。
- 当前 fixed launcher 行为不变；只有采用 Resolver API 的创建/恢复入口获得这些保证。

## 回滚

停止新入口调用 Resolver，恢复 fixed launcher 的 current 选择；保留 Run 中已经固化的 installation digest。移除卸载引用检查会降低安全性，因此只允许在确认不存在活跃引用的受控迁移中回滚。
