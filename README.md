# mutil-skills

面向 Agent Skill 的工程化 monorepo，围绕 schema、可复用模板、CLI 编排层、业务中立 core，以及可安装的测试基建组织代码。

## 工作区

- `packages/core`: JSON、package scripts、文件扫描、错误模型和包管理器命令构建等技术原语。
- `packages/schema`: 基于 Zod 的 `skill.manifest.json` schema、解析器、校验器和 TypeScript 类型导出。
- `packages/template`: 可复用的 foundation/testing 模板和声明式模板注册表。
- `packages/foundation`: 可安装的 `@mutil-skills/foundation` 包，只暴露 `@mutil-skills/foundation/testing`。
- `packages/skills`: 声明式 skill 集合，包含可独立安装的 TDD skill 文件。
- `packages/telemetry`: Claude Code/Codex 的 MCP 与 Skill 调用归一化、统计 reducer、transcript 兜底和 hook 安装逻辑。
- `packages/cli`: `repo-test`、`repo-tdd`、telemetry hook 编排、manifest 校验、测试基建检测和确认式 bootstrap 流程。

## 命令

```bash
npm test
npm run typecheck
npm run lint:architecture
```

Telemetry hook 使用 `install-hooks --runtime all` 显式安装，使用 `uninstall-hooks --runtime all` 卸载；安装后 runtime 位于用户目录，不依赖当前 checkout。第一期默认不保存或上传事件，详细口径见 [统计说明](./docs/telemetry-hook-statistics-guide.md)。

本实现统一使用的包 scope 是 `@mutil-skills/*`。
