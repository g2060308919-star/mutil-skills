# ADR 0012：Task State 使用显式 opt-in 的只读投影

## 状态

Accepted，2026-08-08。

## 背景

Runtime 已分别拥有 Workflow、Run Stage/Condition、MultiCase schedule、Artifact validity、最小缺失输入和 Verdict。调用方需要一个统一视图，但新增可独立写入的 `task-state.json` 会形成第二状态机，并可能与 `RuntimeRunSnapshot` 漂移。

`RuntimeStatusResult` 已公开且使用严格 Schema。若默认向旧响应增加字段，旧版严格客户端可能拒绝响应，因此投影还必须保持线协议兼容。

## 决策

1. `TaskStateViewV1` 只由当前 `RuntimeRunSnapshot` 与 Runtime 已生成的权威 Status 投影确定性构造，不执行 I/O、不持久化、不写回流程状态。
2. 普通 `get-status` 保持原响应；调用方在 payload 显式传入 `includeTaskState: true` 时才附加 `taskState`。
3. `E2EFacade.taskState(handle)` 是公开读取入口，继续复验完整 `RunHandle`，调用方不能用裸 `runId` 猜测当前 Run。
4. Case attempt 直接读取持久 schedule；制品有效性合并 digest 与 preserved/invalidated 事实，并在同一 asset 同时有效和失效时 fail closed。
5. 恢复语义固定为：无外部副作用的 Probe/Preflight blocker 才是 `retry`；同身份且无未知 Case 的执行是 `resume`；running/cleanup Case 或 effect-unknown write 是 `reconcile`；旧状态缺少安全事实是 `migration-required`。
6. `new-run` 保留为 Schema 语义，但当前投影不猜测它。Source、Target 或安装绑定不兼容必须先由未来 Resolver/Ingress 形成显式可信事实，才可投影为 `new-run`；当前 Target 身份修订仍按既有设计在同一 Run 失效下游资产。
7. Task State 不包含 Verdict 推断；业务结论仍只由 Engine 产生。

## 后果

- Facade、CLI 和 UI 可以共享同一状态语言，不再各自解释恢复动作。
- 默认协议和旧客户端行为不变；新客户端可以渐进采用 V1。
- 写结果未知不会因 UI 或 Skill 的通用重试而被重复执行。
- 该视图依赖旧 Status 权威投影作为兼容基线；旧字段移除前需要先完成语义对比和独立迁移 ADR。

## 回滚

移除 `includeTaskState`、`E2EFacade.taskState` 和投影代码即可。没有新增持久数据，也不需要迁移或重写历史 Run。
