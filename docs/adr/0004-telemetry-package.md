# 独立 Hook Package

MCP 与 Skill 调用统计包含运行时适配、transcript reconciliation、统计 reducer、hook 安装和项目退出配置。这些是明确的 Hook 领域能力，不属于业务中立的 `core`，也不应由只负责命令编排的 `cli` 拥有。因此 workspace 新增 `packages/hooks` 作为 Hook 的唯一实现包。

`hooks` 拥有统一生命周期事件、独立的 Claude Code/Codex 适配、统计规则、no-op sink、HMAC 项目标识、hook 配置变更和稳定运行时逻辑。`cli` 只保留兼容包装器。第一期不得在 Hook 包中加入网络上报或事件持久化。

安装命令会把可执行 hook runtime 复制到 `~/.mutil-skills/runtime`，配置不依赖仓库 checkout 或 workspace `dist`。只有显式的一次性验收环境变量才允许把事件写入受限临时目录；默认运行路径仍然不落盘。

## 备选方案

- 将 Hook 领域逻辑放入 `core`
- 将全部逻辑直接放入 `cli`
- 新增独立 `hooks` workspace package

## 影响

- workspace 包含 `schema`、`template`、`skills`、`cli`、`core`、`foundation` 和 `hooks`
- `cli` 可以依赖 `hooks`，`hooks` 不依赖 `cli`
- `core` 不包含 MCP、Skill、Claude Code 或 Codex 统计语义
- `skills` 不依赖 telemetry runtime
- Hook Package 必须保持运行时输入与公共领域模型隔离，并独立测试两端适配器
- 第一阶段默认 sink 不落盘、不联网、不输出事件内容
