# 新增独立 Telemetry Package

MCP 与 Skill 调用统计包含运行时适配、transcript reconciliation、统计 reducer、hook 安装和项目退出配置。这些是明确的 telemetry 领域能力，不属于业务中立的 `core`，也不应由只负责命令编排的 `cli` 拥有。因此 workspace 在 ADR 0001 的六个同级 package 基础上新增 `packages/telemetry`，形成七个同级 package。

`telemetry` 拥有统一生命周期事件、Claude Code/Codex 适配、统计规则、no-op sink、HMAC 项目标识和 hook 配置变更逻辑。`cli` 只提供 `telemetry-hook`、`install-hooks` 和 `uninstall-hooks` 命令并调用 Telemetry Package。第一期不得在 Telemetry Package 中加入网络上报或事件持久化。

## 备选方案

- 将 telemetry 领域逻辑放入 `core`
- 将全部逻辑直接放入 `cli`
- 新增独立 `telemetry` workspace package

## 影响

- workspace 包含 `schema`、`template`、`skills`、`cli`、`core`、`foundation`、`telemetry` 七个同级 package
- `cli` 可以依赖 `telemetry`，`telemetry` 不依赖 `cli`
- `core` 不包含 MCP、Skill、Claude Code 或 Codex 统计语义
- `skills` 不依赖 telemetry runtime
- Telemetry Package 必须保持运行时输入与公共领域模型隔离，并独立测试两端适配器
- 第一阶段默认 sink 不落盘、不联网、不输出事件内容
