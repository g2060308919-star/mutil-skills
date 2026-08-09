# ADR 0013：用品牌保留适配器渐进统一浏览器执行协议

## 状态

Accepted，2026-08-08。

迁移默认值与仓库内 B2B proof 适配边界已由 ADR 0019 supersede；其余决定保持有效。

## 背景

Runtime 已有 Target Probe、Preflight、Read、Reversible Write、Injection 和 Full Playwright 六类生产执行器。它们分别形成了可靠的 Gateway、Authority、一次性 Profile、证据和恢复边界，但能力发现、进度、deadline/cancellation、结果投影和 retry/reconcile 语言并不统一。直接替换现有执行器会同时改变安全品牌、Case、Verdict 和恢复路径，回归面过大。

## 决策

1. 新增 `BrowserExecutorProtocolV1` 作为 Runtime 内部适配协议，不替代现有执行器，也不形成第二个 Browser Runtime。
2. 六类适配器只闭合持有原执行器的 WeakMap capability，并调用原公开可信入口。协议 capability 本身也由独立 WeakMap 签发；调用方不能注入裸 callback 或取得原 backend。
3. 描述符统一声明 kind/effect、输入输出版本、进度、控制边界、证据种类、dispatch 前后 retry 安全、cleanup 和 reconcile。
4. V1 的 timeout 与 cancellation 只在 dispatch 前生效。dispatch 后是否已产生副作用只能由原执行器、Gateway 回执和恢复协议判定，适配器不得用 Promise race 伪造取消成功。
5. 协议结果统一投影 status、outcome digest、effect observation、cleanup、recovery 和证据材料。原始 screenshot/DOM 在 executor→Host 短生命周期边界只标记为待持久材料；只有 Host 写入受控证据仓并生成摘要后才能成为 evidence reference。
6. 写执行器 dispatch 后固定为 `reconcile-required`；effect 为 `unknown` 时结果只能是 `reconcile`，不得自动 retry。
7. 迁移路由默认 `legacy`。`read` 可显式启用 `shadow`：浏览器动作只执行一次，适配器结果与独立旧语义投影进行 fail-closed 比较，避免 GET、计数器或证据动作被重复触发。
8. 本阶段不修改 Case Schema 或 Verdict；所有业务结论仍由既有 Engine 权威产生。

## 后果

- Host 后续可以逐类迁移，不需要一次改写六条执行链。
- 统一进度和恢复语义可被 Task State/UI 使用，但不会形成可独立写入的新状态机。
- V1 不承诺 dispatch 后强制取消；这是为了不把仍在运行的写操作误报为未执行。
- 协议层只产生证据材料状态，真实 evidence URI 仍必须由 Host/Quarantine/Artifact 流程生成。

## 回滚

关闭 `shadow` 路由并删除适配器调用即可恢复全部旧路径。协议未新增持久状态，也未修改 Case、Verdict 或历史 Run，因此无需数据迁移。
