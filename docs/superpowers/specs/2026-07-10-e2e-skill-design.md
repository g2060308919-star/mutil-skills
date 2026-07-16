# PRD 驱动 E2E Skill 设计

## 目标

在 `@mutil-skills/skills` 中发布一个可独立安装的中文 `e2e` Skill。它将 PRD 驱动的浏览器验收流程固化为可复用指令：从 PRD、验收范围和两次用户确认，到 Playwright 执行、回归资产和证据报告。

本次交付的是 Agent Skill，不实现 PRD 方案中从空目录建设的 contracts、core、Playwright runtime 或 report 包。Skill 会要求其宿主使用现有或已提供的确定性工具；缺少这些能力时明确阻塞，绝不伪造执行结果。

## 决策

采用一个入口、多个按需读取的 Markdown 子流程：

```text
packages/skills/skills/testing/e2e/
  SKILL.md
  skill.manifest.json
  prd-intake.md
  acceptance-scope.md
  requirement-model.md
  interaction-flow.md
  coverage-cases.md
  execution-contract.md
  browser-verification.md
  automation-healing.md
  regression-assets.md
  visual-report.md
  artifact-protocol.md
```

入口 `SKILL.md` 是唯一触发点，并严格按权威状态机调度子流程。子文件不是独立安装包；它们是入口在对应节点加载的阶段说明，也可以在用户已具备相应上游产物时单独调用。

## 关键约束

- 在验收范围确认前，不生成确定性需求模型或 Case。
- 在执行契约确认前，不执行任何浏览器 Case；确认须一次覆盖真实链路、故障注入、身份、数据与高风险动作。
- 生产环境默认只读；写入动作必须逐项明确授权；不可恢复动作默认拒绝。
- 真实链路与浏览器级故障注入必须分开记录和报告。写请求的故障注入必须在到达服务端前终止或伪造响应。
- 当前页面只能提供实际结果，不能反向定义 PRD 预期；无视觉规范时不作像素级判断。
- 自动化自愈仅限定位器、等待、动作、页面身份、证据和路由模式；不可改产品、PRD 或断言强度，且无副作用失败最多重跑两次。
- 缺失 URL、账号、权限、数据或运行时能力时报告阻塞并索取最小输入；不得把它们判为业务失败。

## 子流程职责

| 文件 | 责任 |
| --- | --- |
| `prd-intake.md` | 规范化 PRD，确定稳定 PRD-ID、Revision、Asset ID 和差异。 |
| `acceptance-scope.md` | 收敛需求、排除项、歧义、依赖与视觉范围，并完成首次确认。 |
| `requirement-model.md` | 建模 REQ、RULE、角色、状态、转换和可观察结果。 |
| `interaction-flow.md` | 设计入口、主链、分支、反馈和风险标记的预期流程。 |
| `coverage-cases.md` | 生成覆盖矩阵与可追溯 Case，并在 100% 设计审计前回流。 |
| `execution-contract.md` | 集中声明环境、账号、数据、执行队列、注入与风险授权，并完成第二次确认。 |
| `browser-verification.md` | 预检页面身份、绑定语义动作、执行真实链路和故障注入、采集证据。 |
| `automation-healing.md` | 分类失败，进行受限诊断与安全重试。 |
| `regression-assets.md` | 生成、校验并原子发布标准 Playwright `current` 资产和 manifest。 |
| `visual-report.md` | 只根据结构化事实生成 Markdown/HTML 报告和严格 verdict。 |
| `artifact-protocol.md` | 校验 schema、路径安全、脱敏、staging/rollback 与 latest 生命周期。 |

每个子流程均包含：目的、必需输入、可选输入、工作流、详细算法、输出、完成条件、阻塞条件、禁止行为和独立使用示例。

## 发布集成

新增 `skill.manifest.json`，使用现有 `skill.manifest` schema，并在 `packages/skills/src/registry.ts` 中公开唯一的 `e2e` 条目。注册表文件类型将扩展为支持该 Skill 的阶段 Markdown。新增专用 Vitest 测试以覆盖：注册与路径解析、manifest schema、入口引用全部子流程、两次确认门、安全/证据/回归关键规则，以及每个子流程的通用结构。

## 验证

先添加测试，再创建 Skill 文件和注册表实现。最终运行：

```bash
npm test
npm run typecheck
npm run lint:architecture
```

同时检查 `git diff --check`。不新增运行时依赖，也不引入浏览器或网络执行。

## 备选方案

- 把所有阶段写入一个大 `SKILL.md`：较少文件，但会让每次触发加载过多上下文，且难以在单个阶段恢复。
- 发布 12 个独立 Skill：阶段能单独触发，但会造成触发条件重叠，也偏离“一个 E2E Skill”的产品边界。
- 实现完整四包平台：是原始 PRD 的完整产品范围，但超出本仓库新增 Skill 的请求。
