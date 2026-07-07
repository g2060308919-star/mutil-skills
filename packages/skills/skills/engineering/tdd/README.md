# 独立 TDD Skill

这个目录是 TDD Agent Skill 的独立打包边界。

只安装该 skill 时，请一起打包这些文件：

- `SKILL.md`
- `skill.manifest.json`
- `README.md`
- `tests.md`
- `mocking.md`

`skill.manifest.json` 承载 `@mutil-skills/cli` 使用的结构化仓库增强 metadata。独立 Agent Skill 安装不能假设 host runtime 会自动解析这个 manifest，因此 `SKILL.md` 包含明确标记的测试基建预检，指导接入方 agent 如何检测已有 Jest 或 Vitest 基建、在变更前询问用户，并且只在项目没有测试基建时安装 `@mutil-skills/foundation`。

该 skill 应复用完整的现有 Jest 或 Vitest 项目；对于不完整的 Jest 项目，应补齐 Jest 而不是迁移到 Vitest；安装包或写入文件前必须先获得明确确认。默认 Vitest 环境由 `@mutil-skills/foundation/testing` 提供，独立接入时不应额外生成 `vitest.config.ts`。
