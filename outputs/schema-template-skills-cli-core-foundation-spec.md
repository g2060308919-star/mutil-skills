# Schema / Template / Skills / CLI / Core / Foundation Spec

日期：2026-07-07  
状态：开发规格说明  
目标：根据已确认的架构决策，定义一份可直接指导开发的完整 spec。本文档不得替代 ADR，而是把 ADR、术语和实现方向整理成可执行开发约束。

## 1. 背景与目标

本项目采用 `packages/*` workspace 结构，核心目标是建设一套围绕 `schema`、`template`、`skills`、`cli`、`core` 的技能仓库基础设施，并新增可外部安装复用的 `foundation` 包，用于收拢工程基础建设能力。第一版 `foundation` 只开放 `testing` 域，服务于增强后的 `tdd` skill。

第一版必须完成以下目标：

- 建立 `packages/*` 单仓多包结构。
- 保持五个核心包：`schema`、`template`、`skills`、`cli`、`core`。
- 新增第六个可安装包：`foundation`。
- `core` 严格保持无业务语义，只放技术原语。
- `skills` 保存 skill 集合，并复制上游 TDD skill 内容。
- `tdd` 的结构化增强能力放入 `skill.manifest.json`，不直接依赖 `cli`、`foundation` 或 `template` 代码。
- `skills/tdd` 压缩包必须支持 Agent Skill standalone 安装模式，即只安装该 skill 时，接入方 agent 或 host runtime 仍能按可读指令完成测试基建 preflight。
- `schema` 定义并校验 `skill.manifest.json`。
- `foundation/testing` 提供 Vitest-backed 测试运行能力和默认测试环境 API。
- `foundation` 将 `vitest` 放入 `dependencies`，接入方不需要单独理解或安装 Vitest。
- `foundation` 不提供用户命令入口；`repo-test`、`repo-tdd` 由 `cli` 提供。
- `cli` 负责检测测试基建、提示确认、安装/接入 foundation、调用 TDD 流程。
- 当项目已有 Jest 基建但不完整时，优先补齐 Jest，不迁移到 Vitest。
- 当项目没有任何测试基建时，默认使用 Vitest baseline。

## 2. 非目标

第一版不做以下内容：

- 不实现泛化的 `base` 包。
- 不把 `foundation` 设计成所有基础能力的大杂烩。
- 不提供 `runFoundation()` 这类泛化 API。
- 不让 `foundation` 暴露用户-facing bin。
- 不让 `skills` 直接 import `cli`、`foundation`、`template` 的运行时代码。
- 不用 `postinstall` 自动修改接入方项目。
- 不在安装包时静默修改 `package.json`、测试配置或目录结构。
- 不强制把已有 Jest 项目迁移到 Vitest。
- 不把业务规则放进 `core`。
- 不把复制来的上游 `SKILL.md` 当作本仓库结构化增强 metadata 的承载点。
- 不要求所有 agent runtime 自动解析 `skill.manifest.json`；manifest 自动解释能力由本仓库 CLI 提供。

## 3. 包结构

目标目录结构如下：

```text
repo/
├── package.json
├── tsconfig.base.json
├── docs/
│   └── adr/
├── packages/
│   ├── schema/
│   ├── template/
│   ├── skills/
│   ├── cli/
│   ├── core/
│   └── foundation/
└── outputs/
```

推荐包名暂用 `@repo/*` 作为规格中的占位 scope。实际开发时必须在根配置中统一替换为最终 npm scope，不能在不同包中混用多个 scope。

推荐 workspace package 名称：

```text
@repo/schema
@repo/template
@repo/skills
@repo/cli
@repo/core
@repo/foundation
```

## 4. 包职责

### 4.1 `packages/core`

职责：

- 提供无业务语义的技术原语。
- 提供文件系统读写封装。
- 提供 JSON 读写与稳定格式化能力。
- 提供 `package.json` 修改工具。
- 提供路径扫描、路径规范化、错误模型、日志基础能力。
- 提供 package manager 命令构建辅助，例如根据 lockfile 选择 npm/pnpm/yarn。

禁止：

- 禁止出现 skill/template/foundation/schema 业务语义。
- 禁止出现 TDD、Vitest、Jest、模板渲染、skill registry 等领域规则。
- 禁止成为跨包业务公共逻辑桶。

### 4.2 `packages/schema`

职责：

- 定义仓库内结构化数据的 schema。
- 第一版必须定义 `skill.manifest.json` 的结构。
- 导出 TypeScript 类型。
- 导出运行时校验函数。
- CLI 执行任何 skill workflow 前，必须先使用 schema 校验 manifest。

第一版必须包含：

- `SkillManifestSchema`
- `SkillRequirementSchema`
- `TestingFoundationRequirementSchema`
- `TemplateReferenceSchema`
- `parseSkillManifest(input)`
- `validateSkillManifest(input)`

实现建议：

- 使用 TypeScript。
- 推荐使用 Zod 实现运行时校验和类型推导。

### 4.3 `packages/template`

职责：

- 拥有可复用模板资产。
- 提供模板加载和渲染能力。
- 保存 foundation/testing 所需的样例模板、script 模板，以及显式请求时可用的配置模板。
- 允许 `foundation` 消费模板。

第一版模板建议：

```text
packages/template/
├── src/
│   ├── index.ts
│   ├── render-template.ts
│   └── registry.ts
└── templates/
    └── foundation/
        └── testing/
            ├── vitest.config.ts.tmpl
            ├── sample.test.ts.tmpl
            └── package-scripts.json.tmpl
```

约束：

- `template` 不依赖 `foundation`。
- `template` 不知道具体 CLI 交互。
- `skills` 只能通过模板引用声明使用 template，不能直接 import template 代码。

### 4.4 `packages/foundation`

职责：

- 可被外部项目直接安装和复用。
- 包名为 `foundation`，但第一版只开放 `testing` 域。
- 提供 reusable runner/defaults API。
- 提供 Vitest-backed 默认测试环境。
- 将 `vitest` 放入 `dependencies`。
- 可以依赖 `template` 获取样例测试或显式配置模板。
- 不提供用户-facing bin。

第一版 public API：

```ts
import {
  createVitestConfig,
  resolveTestingDefaults,
  runTests,
} from '@repo/foundation/testing'
```

禁止：

- 禁止在 `package.json#bin` 暴露 `repo-test`。
- 禁止实现交互式 prompt。
- 禁止读取 skill manifest 后执行业务 workflow。
- 禁止替代 CLI 做 adoption workflow。

### 4.5 `packages/skills`

职责：

- 保存仓库的 skills 集合。
- 第一版必须包含增强后的 TDD skill。
- 上游 `SKILL.md` 尽量原样复制。
- 本仓库增强 metadata 放在同级 `skill.manifest.json`。
- 为支持 Agent Skill standalone 安装，TDD `SKILL.md` 必须包含一段短的、明确标记的本仓库测试基建 preflight 指令。
- `skills` 保持声明式，不直接依赖 `cli` 或 `foundation` 运行时代码。

第一版 TDD skill 结构：

```text
packages/skills/
├── skills/
│   └── engineering/
│       └── tdd/
│           ├── SKILL.md
│           ├── skill.manifest.json
│           ├── README.md
│           ├── tests.md
│           └── mocking.md
└── src/
    ├── index.ts
    └── registry.ts
```

TDD `SKILL.md` 来源：

```text
https://github.com/mattpocock/skills/blob/main/skills/engineering/tdd/SKILL.md
```

开发时应从 raw 地址复制：

```text
https://raw.githubusercontent.com/mattpocock/skills/main/skills/engineering/tdd/SKILL.md
```

复制策略：

- `SKILL.md` 内容应尽量保持上游原样。
- 允许在 `SKILL.md` 中加入一段短的、本仓库明确标记的 standalone preflight 指令。
- 不把 `skill.manifest.json` 中的结构化 metadata 写进 `SKILL.md`。
- 上游刷新时，优先覆盖 `SKILL.md`，保留本地 `skill.manifest.json`。
- 如果刷新上游 `SKILL.md`，必须重新保留 standalone preflight 指令。
- `README.md` 用于说明 skill 压缩包安装方式、包含文件和运行前置条件。

### 4.6 `packages/cli`

职责：

- 提供用户-facing 命令。
- 提供 `repo-test`。
- 提供 `repo-tdd`。
- 读取 skill manifest。
- 调用 `schema` 校验 manifest。
- 检测接入方测试基建。
- 对缺失基建展示缺失项和拟执行动作。
- 在用户确认后安装或接入 foundation。
- 在用户确认后可选写入 package scripts。
- 调用 `foundation/testing` API 执行测试。
- 执行增强后的 TDD workflow。

禁止：

- 禁止把测试 runner 核心实现写死在 CLI 内部。
- 禁止绕过 `schema` 直接解释未校验的 manifest。
- 禁止在无确认情况下修改接入方项目。

## 5. 依赖边界

允许的内部依赖方向：

```text
core
schema -> core
template -> schema, core
foundation -> template, schema, core
skills -> schema as dev/test validation only; no runtime dependency required
cli -> schema, template, skills, core, foundation
```

必须遵守：

- `core` 不依赖任何内部业务包。
- `schema` 不依赖 `template`、`skills`、`cli`、`foundation`。
- `template` 不依赖 `skills`、`cli`、`foundation`。
- `foundation` 可以依赖 `template`，但 `template` 不能反向依赖 `foundation`。
- `skills` 不 import `cli`。
- `skills` 不 import `foundation`。
- `skills` 不 import `template`。
- `cli` 是 orchestration layer，可以依赖全部其他包。
- 禁止循环依赖。

依赖关系图：

```text
cli
├── schema
├── template
├── skills
├── core
└── foundation
    ├── template
    ├── schema
    └── core

template
├── schema
└── core

schema
└── core
```

## 6. Skill Manifest 规格

`skill.manifest.json` 是机器可读增强声明。它用于描述 skill 的本仓库增强能力、前置能力、模板引用和 orchestration hints。

示例：

```json
{
  "$schema": "../../../../../packages/schema/schemas/skill.manifest.schema.json",
  "id": "tdd",
  "name": "测试驱动开发",
  "source": {
    "type": "github",
    "url": "https://github.com/mattpocock/skills/blob/main/skills/engineering/tdd/SKILL.md",
    "rawUrl": "https://raw.githubusercontent.com/mattpocock/skills/main/skills/engineering/tdd/SKILL.md",
    "ref": "main"
  },
  "requires": [
    {
      "capability": "foundation.testing",
      "satisfiedBy": [
        "jest",
        "vitest",
        "@repo/foundation/testing"
      ],
      "whenMissing": {
        "action": "prompt-install",
        "package": "@repo/foundation",
        "import": "@repo/foundation/testing"
      }
    }
  ],
  "templateReferences": []
}
```

字段要求：

- `id` 必填，必须是稳定 skill id。
- `name` 必填，面向展示。
- `source` 必填，用于记录复制来源。
- `requires` 必填，可以为空数组。
- `requires[].capability` 第一版必须支持 `foundation.testing`。
- `requires[].satisfiedBy` 表示该 capability 可由哪些已有能力满足。
- `requires[].satisfiedBy` 第一版对 TDD 必须包含 `jest`、`vitest`、`@repo/foundation/testing`。
- `requires[].whenMissing.action` 第一版必须支持 `prompt-install`。
- `requires[].whenMissing.package` 第一版对 TDD 必须是 `@repo/foundation`。
- `requires[].whenMissing.import` 第一版对 TDD 必须是 `@repo/foundation/testing`。
- `templateReferences` 可选，表示声明式模板引用，不产生代码依赖。

CLI 处理规则：

- CLI 必须读取 manifest。
- CLI 必须用 `schema` 校验 manifest。
- `requires[].capability` 表示能力需求，不表示必须安装某个包。
- 如果检测到完整 Jest 或 Vitest 基建，`foundation.testing` 视为已满足，不安装 `@repo/foundation`。
- 如果检测到部分 Jest 基建，优先补齐 Jest，不安装 Vitest baseline。
- 只有检测结果为 `missing` 且用户确认时，才执行 `whenMissing` 中声明的安装计划。
- 校验失败时必须停止 workflow，并展示可定位的错误。
- CLI 只能基于校验后的 manifest 执行安装、检测或 runner 调用。
- `skills` 包本身不得因为 manifest 声明而 import `foundation`。

## 7. Foundation Testing API 规格

`@repo/foundation/testing` 第一版只服务测试域。

推荐导出：

```ts
export type TestRunner = 'vitest' | 'jest'

export interface RunTestsOptions {
  cwd: string
  watch?: boolean
  coverage?: boolean
  passWithNoTests?: boolean
  args?: string[]
}

export interface RunTestsResult {
  runner: TestRunner
  exitCode: number
}

export interface TestingDefaults {
  runner: 'vitest'
  environment: 'node'
  testFilePatterns: string[]
}

export function resolveTestingDefaults(): TestingDefaults

export function createVitestConfig(options?: {
  environment?: 'node'
  include?: string[]
}): string

export function runTests(options: RunTestsOptions): Promise<RunTestsResult>
```

实现要求：

- `runTests` 默认使用 Vitest。
- `runTests` 不做交互式 prompt。
- `runTests` 不修改接入方项目。
- `runTests` 接收 CLI 传入的参数。
- `createVitestConfig` 可通过 `template` 渲染默认配置。
- `resolveTestingDefaults` 返回 foundation 自带默认值。
- 第一版不实现 `runFoundation`。
- 第一版不暴露 `@repo/foundation` 根级泛化 API。

`foundation/package.json` 要求：

```json
{
  "name": "@repo/foundation",
  "exports": {
    "./testing": {
      "types": "./dist/testing/index.d.ts",
      "import": "./dist/testing/index.js"
    }
  },
  "dependencies": {
    "vitest": "..."
  }
}
```

不得包含：

```json
{
  "bin": {
    "repo-test": "..."
  }
}
```

## 8. CLI 命令规格

### 8.1 `repo-test`

职责：

- 用户-facing 测试命令。
- 由 `packages/cli` 暴露。
- 委托 `foundation/testing.runTests` 执行。

推荐行为：

```bash
repo-test
repo-test --watch
repo-test --coverage
repo-test -- --runInBand
```

处理规则：

- 不直接 import `vitest`。
- 不把 Vitest 配置逻辑复制到 CLI。
- 必须通过 `foundation/testing` 执行默认测试。
- 如果项目已有 Jest 并且 CLI workflow 明确选择保留 Jest，则 `repo-test` 可以按检测结果走兼容路径。

### 8.2 `repo-tdd`

职责：

- 执行增强后的 TDD workflow。
- 读取 TDD skill 的 `skill.manifest.json`。
- 校验 manifest。
- 检测测试基建。
- 缺失时提示用户确认。
- 确认后安装/接入 foundation。
- 最后执行复制来的 TDD skill 指令流程。

推荐行为：

```bash
repo-tdd
repo-tdd --skill tdd
```

执行顺序：

```text
1. 定位 tdd skill
2. 读取 SKILL.md 和 skill.manifest.json
3. 使用 schema 校验 skill.manifest.json
4. 读取 requires
5. 检测测试基建
6. 如果完整，继续 TDD workflow
7. 如果部分缺失，展示缺失项和补齐计划
8. 如果完全缺失，展示 foundation.testing 安装和接入计划
9. 请求用户确认
10. 用户确认后执行安装/生成/脚本接入
11. 调用 foundation/testing
12. 按 SKILL.md 内容执行 TDD
```

## 9. 测试基建检测规格

CLI 必须做三级检测。

### 9.1 脚本层

检查 `package.json#scripts`：

- `test`
- `test:watch`
- `test:unit`
- 其他明显测试脚本

识别 runner：

- 脚本包含 `vitest`，标记 Vitest。
- 脚本包含 `jest`，标记 Jest。
- 脚本包含 `repo-test`，标记 repo foundation integration。

### 9.2 依赖层

检查 `dependencies`、`devDependencies`、`peerDependencies`：

- `vitest`
- `jest`
- `@types/jest`
- `ts-jest`
- `babel-jest`
- `@repo/foundation`
- `@repo/cli`

规则：

- 没有测试 runner 依赖，且没有 `@repo/foundation`，视为依赖层缺失。
- 有 Jest 相关依赖时，优先判断为 Jest 生态。
- 有 Vitest 相关依赖时，优先判断为 Vitest 生态。
- 同时存在 Jest 和 Vitest 时，CLI 必须展示检测证据，不做静默迁移。

### 9.3 结构层

检查配置文件：

- `vitest.config.ts`
- `vitest.config.js`
- `vitest.config.mjs`
- `jest.config.ts`
- `jest.config.js`
- `jest.config.mjs`

检查测试文件模式：

- `**/*.test.ts`
- `**/*.test.tsx`
- `**/*.spec.ts`
- `**/*.spec.tsx`
- `tests/**/*.ts`
- `test/**/*.ts`
- `__tests__/**/*.ts`

结构层没有任何配置或测试文件时，视为结构缺失。

### 9.4 检测结果

检测结果必须归类为：

```ts
type TestingFoundationStatus =
  | 'complete'
  | 'partial'
  | 'missing'
  | 'conflicted'
```

含义：

- `complete`：脚本、依赖、结构均足以运行测试。
- `partial`：已有测试生态痕迹，但缺少脚本、依赖或结构中的一部分。
- `missing`：没有可识别测试基建。
- `conflicted`：同时存在多个 runner 信号，且无法安全判断默认 runner。

处理规则：

- `complete`：直接执行 TDD 或测试。
- `partial + Jest`：补齐现有 Jest，不迁移 Vitest。
- `partial + Vitest`：补齐 Vitest。
- `missing`：默认采用 foundation/testing 的 Vitest baseline。
- `conflicted`：展示检测证据，要求用户确认采用哪个 runner；不得静默选择。

## 10. Bootstrap 与确认规则

所有会修改接入方项目的动作必须先确认。

需要确认的动作：

- 安装 `@repo/foundation`。
- 写入或修改 `package.json#scripts`。
- 生成样例测试文件。
- 补齐 Jest 配置。
- 修改已有测试配置。

不需要修改项目的动作：

- 读取 manifest。
- 校验 manifest。
- 扫描 package.json。
- 扫描配置文件。
- 扫描测试文件。
- 使用 CLI 自身依赖的一次性 `foundation/testing` runner 执行测试。

推荐确认文案必须包含：

- 检测到的当前状态。
- 缺失项列表。
- 准备安装的包。
- 准备写入或修改的文件。
- 准备增加的 scripts。
- 用户拒绝后的下一步手动命令。

禁止：

- 禁止 `postinstall` 自动修改项目。
- 禁止安装包时静默生成配置。
- 禁止无确认覆盖已有配置。

## 11. 默认测试基建策略

无测试基建时：

- 默认使用 Vitest。
- `foundation` 自带 Vitest。
- CLI 可提示安装 `@repo/foundation` 作为 devDependency。
- CLI 可提示写入 scripts。
- CLI 可提示生成样例测试文件。
- 默认 Vitest 环境由 `@repo/foundation/testing` 提供，不在目标项目生成 `vitest.config.ts`。

已有 Jest 但不完整时：

- 优先补齐 Jest。
- 不主动迁移 Vitest。
- 可以提示用户已有 Jest 信号。
- 可以补齐缺失脚本、配置或测试目录。

已有 Vitest 但不完整时：

- 补齐 Vitest。
- 可复用 foundation/testing 默认配置。

已有完整测试基建时：

- 不安装 foundation。
- 不生成配置。
- 直接执行 TDD workflow。

## 12. Script Integration 规格

CLI 可以提供可选脚本接入，但必须由用户确认。

推荐 scripts：

```json
{
  "scripts": {
    "test": "repo-test",
    "test:watch": "repo-test --watch"
  }
}
```

规则：

- 如果已有 `test` 脚本，不得静默覆盖。
- 如果已有 `test` 脚本是 Jest，且检测为 Jest 生态，优先保留并补齐 Jest。
- 如果没有 `test` 脚本，CLI 可建议新增 `"test": "repo-test"`。
- `repo-test` 由 `@repo/cli` 提供。
- `foundation` 不提供 `repo-test` bin。

## 13. Template Reference 规则

Skill 可以声明模板引用，但不能直接依赖 template 代码。

允许：

```json
{
  "templateReferences": [
    {
      "id": "foundation.testing.sample-test"
    }
  ]
}
```

禁止：

```ts
import { renderTemplate } from '@repo/template'
```

在 `skills` 包中出现上面的 import 属于架构违规。

真正渲染模板的地方：

- `cli` 在 workflow 中调用。
- `foundation` 在生成 testing defaults 时调用。

## 14. TDD Skill 集成规格

TDD skill 第一版由三部分组成：

```text
SKILL.md
skill.manifest.json
README.md
tests.md
mocking.md
```

`SKILL.md`：

- 从 GitHub 上游复制。
- 尽量保持原文。
- 用于保留 TDD 工作流的人类/agent 指令。
- 包含一段短的 standalone preflight 指令，用于没有 CLI manifest 解释器时指导接入方 agent 执行测试基建检测和确认安装。

`skill.manifest.json`：

- 声明本仓库增强。
- 声明 `requires[].capability = foundation.testing`。
- 声明已有 Jest、Vitest 或 `@repo/foundation/testing` 均可满足该 capability。
- 声明 capability 缺失时 `prompt-install @repo/foundation`。
- 由 `schema` 校验。
- 由 `cli` 解释。

`README.md`：

- 说明如何只打包 `skills/engineering/tdd`。
- 说明如何把压缩包安装到接入方 agent 的 skills 目录。
- 说明 standalone 模式依赖 host runtime 读取 `SKILL.md` 指令，不依赖 runtime 自动解析 manifest。

`repo-tdd` workflow 必须在执行 TDD 前保证：

- manifest 已校验。
- 测试基建已检测。
- 缺失基建已经提示并确认。
- 所需 foundation/testing 能力可用。

### 14.1 Agent Skill Standalone 模式

目标：

- 允许只压缩并分发 `packages/skills/skills/engineering/tdd`。
- 接入方把该目录安装到 agent skills 目录后，可以直接让 agent 按 TDD 模式开发。
- 如果产品项目已有完整 Jest 或 Vitest，agent 必须复用现有测试基建。
- 如果产品项目已有部分 Jest，agent 必须优先补齐 Jest。
- 如果产品项目没有测试基建，agent 必须先提示用户确认，再安装 `@repo/foundation` 并使用 `@repo/foundation/testing` 提供的测试基建。

约束：

- Standalone 模式不能假设 host runtime 会自动解析 `skill.manifest.json`。
- Standalone 模式的可执行指令必须出现在 `SKILL.md` 的明确标记 preflight 段落中。
- `skill.manifest.json` 仍然必须随压缩包分发，供本仓库 CLI、未来 runtime 或其他工具读取。
- Standalone preflight 指令只描述执行策略，不写结构化 metadata。
- Standalone preflight 指令不得要求用户理解 Vitest 细节；对用户展示的是测试基建安装计划和是否确认。

Standalone preflight 顺序：

1. 检查 `package.json` scripts、依赖、lockfile、测试配置和测试目录。
2. 如果检测到完整 Jest 或 Vitest，直接使用现有命令进入 TDD red-green-refactor。
3. 如果检测到部分 Jest，先提示并补齐 Jest 所缺配置或脚本。
4. 如果检测为缺失，展示将安装 `@repo/foundation` 并接入测试基建的计划。
5. 用户确认后，使用项目现有 package manager 安装 `@repo/foundation`。
6. 安装完成后，继续按上游 `SKILL.md` 的 TDD 流程开发。
7. 用户拒绝时，不安装依赖、不写配置，并说明无法在无测试基建下继续 TDD。

## 15. 外部接入方式

接入方可以选择三种方式。

### 15.1 命令方式

安装 CLI：

```bash
npm install -D @repo/cli
```

运行：

```bash
npx repo-test
npx repo-tdd
```

说明：

- `@repo/cli` 依赖 `@repo/foundation`。
- 接入方不需要单独安装 Vitest。
- 如需持久接入 scripts，CLI 必须先确认。

### 15.2 API 方式

安装 foundation：

```bash
npm install -D @repo/foundation
```

使用：

```ts
import { runTests } from '@repo/foundation/testing'
```

说明：

- 适合外部工具或自定义 CLI 复用测试基建。
- 不提供交互。
- 不修改项目。

### 15.3 Agent Skill 压缩包方式

打包范围：

```text
packages/skills/skills/engineering/tdd/
├── SKILL.md
├── skill.manifest.json
├── README.md
├── tests.md
└── mocking.md
```

说明：

- 适合只想安装 TDD skill 的接入方。
- 该方式不要求接入方先安装 `@repo/cli`。
- 该方式依赖 host runtime 读取 `SKILL.md` 中的 standalone preflight 指令。
- 如果项目已有完整 Jest 或 Vitest，不安装 `@repo/foundation`。
- 如果项目没有测试基建，先确认，再安装 `@repo/foundation`。
- `@repo/foundation` 具体包含 Vitest baseline 的事实对接入方保持无感知，agent 只展示必要的安装计划。

## 16. 实现顺序

推荐按以下顺序开发。

### 阶段 1：Workspace scaffold

产物：

- 根 `package.json`
- `tsconfig.base.json`
- `packages/core`
- `packages/schema`
- `packages/template`
- `packages/foundation`
- `packages/skills`
- `packages/cli`

验收：

- 所有 package 能被 workspace 识别。
- 每个 package 有独立 `package.json`。
- 每个 package 有明确 `exports`。

### 阶段 2：Core 技术原语

产物：

- 文件读写工具。
- JSON 读写工具。
- package.json 修改工具。
- 路径扫描工具。
- 错误模型。

验收：

- core 单测覆盖 JSON 修改和路径扫描。
- core 不出现 skill/template/foundation/testing 语义。

### 阶段 3：Schema manifest 校验

产物：

- `SkillManifestSchema`
- manifest parser
- manifest validator
- manifest 类型导出

验收：

- 合法 TDD manifest 通过校验。
- 缺失 `requires[].capability` 时失败。
- 未知 capability 时失败或明确进入 unsupported 分支。

### 阶段 4：Template foundation/testing 模板

产物：

- Vitest config 模板。
- sample test 模板。
- script fragment 模板。
- template renderer。

验收：

- 可按显式请求渲染 `vitest.config.ts`。
- 可渲染 sample test。
- template 不依赖 foundation。

### 阶段 5：Foundation testing API

产物：

- `@repo/foundation/testing`
- `runTests`
- `createVitestConfig`
- `resolveTestingDefaults`
- Vitest dependency

验收：

- `foundation` 无 bin。
- `foundation` package dependencies 包含 `vitest`。
- `runTests` 可被 CLI 调用。
- API 不做交互、不写文件。

### 阶段 6：Skills TDD 内容和 manifest

产物：

- `packages/skills/skills/engineering/tdd/SKILL.md`
- `packages/skills/skills/engineering/tdd/skill.manifest.json`
- `packages/skills/skills/engineering/tdd/README.md`
- skill registry

验收：

- `SKILL.md` 来自指定 GitHub URL。
- `SKILL.md` 保留 standalone preflight 指令。
- `skill.manifest.json` 声明 `foundation.testing`。
- `skill.manifest.json` 将完整 Jest、完整 Vitest 和 `@repo/foundation/testing` 都声明为可满足 capability。
- `README.md` 说明 skill 压缩包安装和 standalone 行为。
- `skills` 不 import `cli` 或 `foundation`。

### 阶段 7：CLI repo-test / repo-tdd

产物：

- `repo-test` bin。
- `repo-tdd` bin。
- 测试基建 detector。
- bootstrap confirmation flow。
- package install command executor。
- optional script integration flow。

验收：

- `repo-test` 调用 foundation/testing。
- `repo-tdd` 先校验 manifest。
- 完整 Jest 或 Vitest 项目不安装 `@repo/foundation`。
- 没有测试基建时提示安装/接入 foundation。
- 用户拒绝时不修改项目。
- 用户确认时按计划安装/生成/写 scripts。
- Jest partial 项目不被迁移到 Vitest。

## 17. 测试要求

必须覆盖以下测试。

Schema：

- 有效 manifest 校验通过。
- 缺失必填字段校验失败。
- `requires[].capability = foundation.testing` 校验通过。
- 非法 capability 校验失败。

Core：

- package.json scripts 安全写入。
- 已有 scripts 不被静默覆盖。
- JSON 格式化稳定。
- 路径扫描忽略 `node_modules`。

Template：

- Vitest config 模板渲染正确。
- sample test 模板渲染正确。

Foundation：

- `createVitestConfig` 输出可用配置。
- `resolveTestingDefaults` 返回 Vitest baseline。
- `runTests` 可传递 cwd、watch、coverage、args。
- package 没有 bin。

Skills：

- TDD manifest 通过 schema 校验。
- TDD SKILL.md 文件存在。
- TDD SKILL.md 包含 standalone preflight 指令。
- TDD README.md 文件存在。
- skills 包没有导入 cli/foundation/template。

CLI：

- 无测试基建项目检测为 `missing`。
- Vitest 部分项目检测为 `partial`。
- Jest 部分项目检测为 `partial` 且 runner 为 Jest。
- 混合 Jest/Vitest 项目检测为 `conflicted`。
- `repo-tdd` 在 manifest 无效时停止。
- `repo-tdd` 在完整 Jest/Vitest 项目中不安装 foundation。
- `repo-tdd` 在缺失测试基建时提示确认。
- 用户拒绝时不写文件、不安装包。
- 用户确认时执行安装计划。
- optional script integration 需要确认。
- `repo-test` 委托 foundation/testing。

Agent Skill Standalone：

- `skills/engineering/tdd` 可单独打包。
- 压缩包包含 `SKILL.md`、`skill.manifest.json`、`README.md`、`tests.md`、`mocking.md`。
- `SKILL.md` 指示 agent 先检测测试基建。
- 完整 Jest/Vitest 项目不安装 `@repo/foundation`。
- 无测试基建项目先确认，再安装 `@repo/foundation`。

## 18. 架构验收标准

第一版完成时必须满足：

- 仓库使用 `packages/*` 结构。
- 存在六个 workspace package：`schema`、`template`、`skills`、`cli`、`core`、`foundation`。
- `core` 无业务语义。
- `foundation` 可外部安装。
- `foundation` 第一版只公开 `testing` 域。
- `foundation` 将 `vitest` 放在 `dependencies`。
- `foundation` 不暴露 bin。
- `cli` 暴露 `repo-test`。
- `cli` 暴露 `repo-tdd`。
- `skills` 不直接依赖 `foundation`、`cli`、`template`。
- TDD skill 有 `SKILL.md`、`skill.manifest.json`、`README.md`、`tests.md` 和 `mocking.md`。
- TDD skill 可作为 `skills/engineering/tdd` 压缩包单独安装到 agent skills 目录。
- TDD `SKILL.md` 包含 standalone preflight 指令。
- `skill.manifest.json` 由 `schema` 校验。
- 缺失测试基建时，CLI 先检测、展示计划、请求确认，再安装或写入。
- 缺失测试基建时，standalone 指令同样要求先检测、展示计划、请求确认，再安装。
- 已有 Jest 生态时优先补齐 Jest，不迁移 Vitest。
- 已有完整 Jest 或 Vitest 时，不安装 `@repo/foundation`。
- 模板引用保持声明式，不产生 skills 到 template 的代码依赖。
- 没有任何 `postinstall` 自动改项目行为。

## 19. 关键开发约束

实现中如果出现以下情况，视为偏离 spec：

- 把 `repo-test` 放进 `foundation` 的 bin。
- 在 `skills` 中 import `@repo/foundation`。
- 在 `skills` 中 import `@repo/template`。
- 在 `core` 中出现 `tdd`、`skill`、`template`、`vitest`、`jest` 领域逻辑。
- `repo-tdd` 不校验 manifest 就执行。
- `repo-tdd` 在未确认情况下修改项目。
- 默认把 Jest 项目迁移到 Vitest。
- 使用 `postinstall` 自动生成配置。
- 把结构化增强 metadata 写进复制来的 `SKILL.md`，导致上游同步困难。
- 删除 `SKILL.md` 中 standalone preflight 指令，导致单独安装 skill 后无法触发测试基建检测。

## 20. 参考 ADR

- `docs/adr/0001-package-topology.md`
- `docs/adr/0002-installable-foundation-package.md`
- `docs/adr/0003-skill-manifest-for-enhancements.md`

以上 ADR 是架构决策来源。若实现中发现 spec 与 ADR 冲突，必须先更新 ADR 或修订 spec，不能直接让代码自行偏离。
