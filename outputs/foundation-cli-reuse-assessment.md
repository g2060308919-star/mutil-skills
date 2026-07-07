# Foundation-Cli 复用评估

日期：2026-07-07  
对象：[ronak-create/Foundation-Cli](https://github.com/ronak-create/Foundation-Cli)  
结论：该仓库没有完成我们 spec 需要的 `foundation/testing + repo-test + repo-tdd + skill.manifest.json` 能力，但有若干局部实现可以参考或改造。

## 摘要

`Foundation-Cli` 是一个全栈项目脚手架 CLI，包结构为 `cli`、`core`、`modules`、`plugin-sdk`、`testing`。它不是我们定义的 `schema`、`template`、`skills`、`cli`、`core`、`foundation` 结构，也没有 TDD skill、`skill.manifest.json`、`foundation/testing` public API、`repo-test`/`repo-tdd` 命令。

可以参考的重点是工程骨架、CLI 命令分发、manifest schema 校验、包管理器检测、JSON/YAML/env merge、路径安全解析和测试 fixture helper。不能直接整体搬运，因为它的 `core` 含有大量脚手架领域逻辑，违反我们“core 无业务语义”的约定。

## 来源事实

- GitHub 仓库公开，MIT license，默认分支 `main`，描述为 full-stack project assembler。来源：[repo metadata](https://api.github.com/repos/ronak-create/Foundation-Cli)
- workspace 使用 `packages/*`。来源：[pnpm-workspace.yaml](https://raw.githubusercontent.com/ronak-create/Foundation-Cli/main/pnpm-workspace.yaml)
- 包列表是 `cli`、`core`、`modules`、`plugin-sdk`、`testing`。来源：[packages contents](https://api.github.com/repos/ronak-create/Foundation-Cli/contents/packages?ref=main)
- CLI 包名是 `@systemlabs/foundation-cli`，bin 是 `foundation`，不是 `repo-test` 或 `repo-tdd`。来源：[packages/cli/package.json](https://raw.githubusercontent.com/ronak-create/Foundation-Cli/main/packages/cli/package.json)
- testing 包名是 `@systemlabs/foundation-testing`，`vitest` 在 `peerDependencies` 和 `devDependencies`，不是 runtime `dependencies`。来源：[packages/testing/package.json](https://raw.githubusercontent.com/ronak-create/Foundation-Cli/main/packages/testing/package.json)
- testing 包源码只导出 fixtures helper。来源：[packages/testing/src/index.ts](https://raw.githubusercontent.com/ronak-create/Foundation-Cli/main/packages/testing/src/index.ts), [fixtures.ts](https://raw.githubusercontent.com/ronak-create/Foundation-Cli/main/packages/testing/src/fixtures.ts)
- `foundation test` 只代理执行当前项目的 `npm/pnpm/yarn run test`，不是 self-contained runner。来源：[packages/cli/src/commands/dev.ts](https://raw.githubusercontent.com/ronak-create/Foundation-Cli/main/packages/cli/src/commands/dev.ts)
- plugin-sdk 使用 AJV 校验 manifest。来源：[schema.ts](https://raw.githubusercontent.com/ronak-create/Foundation-Cli/main/packages/plugin-sdk/src/schema.ts), [validate.ts](https://raw.githubusercontent.com/ronak-create/Foundation-Cli/main/packages/plugin-sdk/src/validate.ts)
- npm 上存在 `@systemlabs/foundation-cli`、`@systemlabs/foundation-testing`、`@systemlabs/foundation-core`，latest 均为 `0.3.1`。来源：2026-07-07 的 `npm view`。

## 与本项目 Spec 的匹配度

不满足：

- 没有 `packages/schema`、`packages/template`、`packages/skills`、`packages/foundation`。
- 没有 `tdd` skill。
- 没有 `skill.manifest.json`。
- 没有 `foundation/testing` API。
- 没有 `repo-test`、`repo-tdd`。
- 没有三级测试基建检测。
- 没有缺失测试基建时 prompt-install foundation 的流程。
- 没有 Jest partial setup 的补齐策略。
- `@systemlabs/foundation-testing` 不自带 Vitest runtime dependency。

部分符合：

- 有 `packages/*` monorepo 结构。
- 有 TypeScript、tsup、Vitest、Turborepo 基建。
- 有 CLI command dispatcher。
- 有 AJV manifest validation 模式。
- 有 package manager detection。
- 有 project doctor/reporting 思路。
- 有 JSON/YAML/env merge 工具。
- 有 path traversal guard。

## 可复用内容

可直接参考并重写：

- `packages/plugin-sdk/src/validate.ts` 的 `ValidationResult`、AJV compile、错误聚合模式，可迁移到我们的 `packages/schema`。
- `packages/core/src/path-utils.ts` 的 `safeResolve` 思路，可迁移到我们的 `packages/core`。
- `packages/core/src/installer/install.ts` 的 lockfile-based package manager detection，可改造成我们的 package manager helper。
- `packages/core/src/file-merger/json-merge.ts` 的 JSON/YAML/env merge 思路，可拆到我们的 `core` JSON 工具或 package script 修改工具。
- `packages/testing/src/fixtures.ts` 的 temp dir/file fixture helper，可作为我们测试辅助参考。
- `packages/cli/src/index.ts` 的命令分发结构，可作为 `repo-test`、`repo-tdd` CLI 入口参考。
- `packages/cli/src/commands/doctor.ts` 的诊断 report 形式，可参考用于测试基建检测报告。

不建议搬：

- 整个 `packages/core`，因为其中包含 module registry、dependency resolver、generator、installer、templating 等脚手架领域逻辑。
- 整个 `packages/testing`，因为它不是自包含测试基建。
- `foundation test` 命令实现，因为它只是代理 `npm run test`，不满足我们的 foundation/testing runner 设计。
- `modules` 包，因为它是全栈脚手架模块库，与当前 skill/foundation 目标偏离。

## 推荐迁移计划

1. 借鉴 repo 的 `packages/*`、tsup、turbo、Vitest workspace 基建，但按我们 spec 创建 `schema/template/skills/cli/core/foundation`。
2. 在 `schema` 中重写 AJV 或 Zod manifest validator，参考 `plugin-sdk` 的错误聚合。
3. 在 `core` 中重写 `safeResolve`、package manager detection、JSON package script 修改工具。
4. 在 `foundation/testing` 中从零实现 `runTests`、`createVitestConfig`、`resolveTestingDefaults`，并把 `vitest` 放入 `dependencies`。
5. 在 `cli` 中实现 `repo-test` 和 `repo-tdd`，不要复用其 `foundation test` 代理逻辑。
6. 在 `skills` 中复制上游 TDD `SKILL.md`，新增 `skill.manifest.json` 声明 `foundation.testing`。
