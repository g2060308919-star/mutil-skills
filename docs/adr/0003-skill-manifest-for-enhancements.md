# 使用 Skill Manifest 承载仓库增强

复制来的 skills 应尽量保持上游 `SKILL.md` 内容稳定，而仓库特定 requirements 和 orchestration hints 放在同级 `skill.manifest.json` 中。这让 CLI 能读取结构化 metadata，例如 `requires[].capability = "foundation.testing"`，同时避免 skill 正文依赖 CLI 或 foundation 代码。

对于还必须作为 standalone Agent Skill package 工作的 skills，`SKILL.md` 可以包含一段简短、明确标记的人类可读 preflight 指令。该指令不是结构化 metadata 的来源；它存在的目的是让不会自动解析 `skill.manifest.json` 的 host runtime 仍能执行预期 setup 流程。

## 备选方案

- 将仓库特定增强 metadata 放进 `SKILL.md` frontmatter
- 将增强 metadata 存储在 `skill.manifest.json`

## 影响

- 上游 skill 内容可以更低摩擦地复制或刷新
- `skills` 保持声明式，不 import `cli` 或 `foundation`
- `schema` 拥有 manifest 结构校验
- `cli` 解释 manifests，并在需要时调用 foundation 能力
- CLI workflow 必须先按 schema-owned contract 校验 `skill.manifest.json`，再根据 `foundation.testing` 等 requirements 执行动作
- Standalone Agent Skill package 必须在 `SKILL.md` 中保留必要 preflight 指令，因为 host runtime 不保证会解释 manifest
