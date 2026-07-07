# 实现审计 2026-07-07

来源文档：

- `CONTEXT.md`
- `docs/adr/0001-package-topology.md`
- `docs/adr/0002-installable-foundation-package.md`
- `docs/adr/0003-skill-manifest-for-enhancements.md`
- `outputs/schema-template-skills-cli-core-foundation-spec.md`
- `outputs/foundation-cli-reuse-assessment.md`

## 结果

已在 npm scope `@mutil-skills/*` 下实现第一版 `schema` / `template` / `skills` / `cli` / `core` / `foundation` monorepo。

## 按规格领域核对

- 工作区脚手架：已包含根 `package.json`、`tsconfig.base.json`、`packages/*`、六个 workspace package 和 package exports。
- Core：`packages/core` 已实现 JSON 读写、稳定格式化、scripts 合并且不静默覆盖、忽略 `node_modules` 的路径扫描、包管理器检测、安装命令构建，以及中立错误模型。
- Schema：`packages/schema` 已实现 `SkillManifestSchema`、`SkillRequirementSchema`、`TestingFoundationRequirementSchema`、`TemplateReferenceSchema`、`parseSkillManifest`、`validateSkillManifest`，并在 `schemas/skill.manifest.schema.json` 导出 JSON schema 文件。
- Template：`packages/template` 已包含 foundation/testing 可复用模板，包括显式 Vitest 配置模板、样例测试、package scripts 模板，以及声明式 registry 和 renderer；默认 TDD bootstrap 不再生成 `vitest.config.ts`。
- Foundation：`@mutil-skills/foundation/testing` 暴露 `createVitestConfig`、`resolveTestingDefaults`、`runTests`；`runTests` 自带默认 Vitest node 环境；`vitest` 位于 runtime dependencies；该包没有 `bin`。
- Skills：`packages/skills/skills/engineering/tdd` 包含 `SKILL.md`、`skill.manifest.json`、`README.md`、`tests.md`、`mocking.md`；manifest 声明 `foundation.testing`；`SKILL.md` 包含通用独立安装预检指令；skills 源码没有导入 CLI、foundation 或 template runtime 包。
- CLI：已声明 `repo-test` 和 `repo-tdd` bin；`repo-test` 委托 foundation testing；`repo-tdd` 在 workflow 前读取 `SKILL.md`、校验 manifest、检测测试基建、要求 bootstrap 确认、执行包安装回调，并接入 runner 对应的 baseline 文件。
- 检测：已检查 script、dependency、structure 三层；状态包含 `complete`、`partial`、`missing`、`conflicted`；部分 Jest 项目保留 Jest，不迁移到 Vitest。
- 架构护栏：`npm run lint:architecture` 检查 workspace package 存在、foundation 没有 bin、skills 没有 forbidden runtime import、core 没有领域词。
- 发布打包：所有 workspace package 都声明 `files` allowlist，确保 packed package 包含 `dist/src` 和必要 runtime assets，同时排除测试与原始源码。
- 运行时：构建后的 `repo-test` 和 `repo-tdd --skill tdd` 都可从 `packages/cli/dist` 成功执行。

## 验证

- `npm test`：43 个测试通过。
- `npm run typecheck`：通过。
- `npm run lint:architecture`：通过。
- `node packages/cli/dist/src/bin/repo-test.js -- --run`：通过。
- `node packages/cli/dist/src/bin/repo-tdd.js --skill tdd`：通过。
- `npm pack --dry-run --workspaces`：所有 workspace tarball 都包含构建产物和必要的 schema/template/skill assets，`@mutil-skills/skills` 包含 TDD `tests.md` 与 `mocking.md`。
- Package export smoke check：
  - `@mutil-skills/foundation/testing` 可以导入并返回 `vitest`。
  - `@mutil-skills/cli` 可以导入并暴露 `detectTestingFoundation`。

## 备注

- 原规格使用 `@repo/*` 作为占位 scope。由于未提供最终 scope，本实现统一使用从仓库名推导出的 `@mutil-skills/*`。
- 未创建 git commit。
