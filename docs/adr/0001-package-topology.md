# 使用同级 package 和业务中立 core

本仓库采用 `packages/*` workspace 布局，包含六个同级 package：`schema`、`template`、`skills`、`cli`、`core`、`foundation`。选择同级 package，而不是单一混合源码树，是因为这些关注点处在不同层级，需要明确依赖边界，也更容易独立测试和演进。`core` 被刻意限制为只包含技术原语，避免变成其他 package 领域逻辑的通用垃圾桶。`skills` 通过声明式方式引用 templates，而 `cli` 执行运行时组装并调用 `template` 代码。仓库的 TDD skill 也依赖由 `cli` 编排的 test-foundation bootstrap，而不是假设测试基建已经存在；缺失 foundation 时，任何安装或文件写入前都必须触发显式用户确认。可外部复用的 foundation 能力由 ADR 0002 中描述的专用 `packages/foundation` package 处理。

## 备选方案

- 单一应用源码树，内部包含五个顶层源码目录
- 六个同级 workspace package

## 影响

- `cli` 作为编排入口，而不是隐藏领域规则的位置
- `schema`、`template`、`skills` 可以独立演进和测试
- `core` 需要主动护栏，确保业务逻辑留在所属 package
- `skills` 可以通过 template references 选择输出形态，而不直接依赖 `template` 代码
- TDD 可以接入空仓库，因为 `cli` 可在复制来的 skill 运行前安装或接入最低测试基建
- 修改项目的 bootstrap 保持显式，因为检测结果和拟执行变更会在安装或写入前展示
- 测试就绪状态按三层检测：package scripts、test runner dependencies、可识别测试结构
- 没有测试基建的新项目使用 Vitest 作为默认 runner；已有测试生态仍可被检测并尊重
- 部分 Jest setup 会在原地补齐，而不是迁移到 Vitest
- `cli` 拥有测试基建编排，`template` 拥有可复用 foundation templates，`core` 只拥有可复用技术文件和 package-json utilities
- CLI 可以把 package-script integration 作为可选确认步骤，例如把消费项目的 test script 接到仓库管理的 test command
