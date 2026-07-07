# Schema Template Skills CLI Core 术语表

本文档描述一个围绕 schema 驱动内容、可复用 template、skill、CLI 入口和业务中立 core 构建的 monorepo 架构词汇。

## 术语

**Package**：
monorepo 内位于顶层 workspace 的模块，拥有自己的源码、测试和依赖边界。
_避免使用_：folder、directory、module

**Schema**：
定义仓库内内容和配置所用结构契约、类型与校验规则的 package。
_避免使用_：model、config shape

**Template**：
拥有可复用模板资产，并负责从结构化输入渲染模板的 package。
_避免使用_：scaffold、preset

**Skill**：
以结构化 skill 内容和支撑代码打包的仓库能力，受仓库约定约束，并可被工具发现。
_避免使用_：script、snippet

**Skill Manifest**：
机器可读的 `skill.manifest.json` 文件，用于记录仓库特定的 skill metadata、requirements 和 orchestration hints，同时保持复制来的 skill 内容稳定。
_避免使用_：embedded enhancement text、modified upstream skill body

**Standalone Agent Skill Package**：
可分发的 skill 目录，例如 `skills/engineering/tdd`。它可以不依赖仓库 CLI 单独安装，因此必须在 `SKILL.md` 中包含足够的人类可读 preflight 指令，让接入方 agent 或 host runtime 能安全执行必要 setup。
_避免使用_：CLI-only skill、manifest-only runtime package

**Manifest Schema**：
由 schema package 拥有的契约，用于在 CLI workflow 解释 `skill.manifest.json` 前定义并校验其形状。
_避免使用_：untyped manifest、CLI-only manifest parsing

**Template Reference**：
skill 或配置中保存的声明式标识符，用来命名应使用哪个 template，而不直接导入或执行 template 代码。
_避免使用_：template dependency、render hook

**Testing Foundation**：
测试驱动 workflow 运行前所需的最低项目级测试基础设施，包括测试 scripts、runner 选择、runner 默认环境和测试文件放置约定。
_避免使用_：optional test setup、ad hoc testing

**Foundation Package**：
可外部安装的 `foundation` package，提供可复用工程基础能力，第一项能力是测试基础设施。
_避免使用_：base、common package、hidden CLI internals

**Foundation Runner**：
foundation package 导出的可复用执行表面，例如测试运行或默认 runner 配置；它不拥有面向用户的 workflow prompt。
_避免使用_：CLI command、interactive setup flow

**Testing Domain**：
foundation package 暴露的第一个 public API domain，仅聚焦测试基建能力。
_避免使用_：generic foundation API、all-purpose infrastructure API

**Foundation Template**：
template package 拥有的可复用模板，用于生成 example tests、script fragments 或显式请求的测试基建文件。
_避免使用_：CLI-owned config、skill-owned test files

**Foundation Orchestration**：
CLI 拥有的流程：检测测试就绪状态、展示缺失的 foundation、请求 bootstrap 确认，并应用安装或生成步骤。
_避免使用_：skill installer、template executor

**Foundation Detection**：
CLI 在决定 TDD 是否可以运行或是否需要 bootstrap 前，对 scripts、dependencies 和 test structure 做的三级测试就绪检查。
_避免使用_：test script check、runner check

**Vitest Baseline**：
当项目没有现有测试基建时，由 CLI 确认后接入的默认测试基建。它安装 `@mutil-skills/foundation`、写入 scripts 和样例测试；默认 Vitest 环境由 foundation runner 提供，不在目标项目生成 `vitest.config.ts`。
_避免使用_：Jest default、generic test runner

**Runner Compatibility**：
CLI 保留现有测试 runner 选择（例如 Jest）并补齐缺失部分的规则，而不是迁移到默认 runner。
_避免使用_：forced migration、runner replacement

**Bootstrap Confirmation**：
检测到缺失测试基建后、应用项目修改前的显式用户确认步骤。
_避免使用_：silent setup、implicit install

**Script Integration**：
可选且需用户确认的接入方式，用于把消费项目的 package scripts 连接到仓库管理的命令，例如 test 或 TDD runner。
_避免使用_：mandatory script rewrite、hidden command install

**CLI**：
暴露命令行入口并编排其他 packages 的 package；它不拥有各领域规则。
_避免使用_：app、runtime

**Core**：
提供跨 package 技术原语的 package，必须保持不含 skill、template 或 schema 特定业务语义。
_避免使用_：common business logic、shared domain helpers
