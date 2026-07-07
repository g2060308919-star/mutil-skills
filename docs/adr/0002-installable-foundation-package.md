# 新增可安装的 Foundation Package

Foundation 能力需要可被外部项目直接安装和复用，因此会从 CLI/template 内部的 `foundation/` 目录提升为 `packages/foundation`。package 名称围绕更窄的 `foundation` 概念，而不是 `base`，因为它拥有的是可消费的工程基础设施，而不是泛化共享代码。

## 备选方案

- 将 foundation 代码保留为 `cli` 和 `template` 内部的 `foundation/` 目录
- 增加一个供外部复用的可安装 foundation package
- 使用宽泛的 `base` package 承载基础设施和共享原语

## 影响

- 外部项目可以直接安装 foundation package
- `cli` 可以编排 foundation 接入，而不拥有可复用 foundation surface
- `core` 保持仅限业务中立技术原语
- foundation package 必须比 `base` 更聚焦，避免成为第二个通用垃圾桶
- workspace 布局变为 `packages/*`，`foundation` 与五个核心 package 同级，而不放在其中某一个内部
- `foundation` 暴露可复用 runner/defaults API；面向用户的命令、prompt、检测报告和接入 workflow 仍留在 `cli`
- `foundation` 可以依赖 `template` 来消费 foundation 相关 sample-test 或显式配置模板，但 `template` 不依赖 `foundation`
- `foundation` 将 Vitest 放入 runtime dependencies，使消费项目无需单独理解或安装默认 test runner
- `foundation` 不暴露面向用户的 test binary；`cli` 提供 `repo-test` 等命令并委托给 foundation APIs
- package 名称保持为 `foundation`，但第一个 public API 限定为 `testing` domain，而不是泛化 foundation API
