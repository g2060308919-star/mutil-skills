# E2E P0：PRD 完整性、Oracle 检查点与报告落盘实施计划

> 实施原则：每个任务先补最小失败测试，确认失败原因与目标能力一致，再写实现并运行相关回归；最后运行全仓测试、构建和 Golden。

## 目标

让正式代际能够证明并展示：

`PRD 原文条款 → 条款处置 → Requirement → Rule → Oracle → Coverage Obligation → Case → Step → Runtime Oracle Checkpoint → Evidence → Verdict → JSON/Markdown/离线 HTML 报告`

任何未建模条款、断裂映射、未执行 Oracle 或缺失证据都不得得到 `accepted`。

## Task 1：PRD Clause Inventory 契约

- 在 `prd-manifest` 中加入带来源行列、原文、规范文本、摘要的条款清单及清单摘要。
- 保证 sourceId 存在、条款 ID 唯一、区间有效、条款摘要和清单摘要可复算。
- 在 `acceptance-scope` 中加入每个条款恰好一次的处置记录：modeled、excluded、not-applicable 或 ambiguous。
- 测试缺条款、重复条款、摘要漂移、未知 source、重复/遗漏处置。

## Task 2：原子 Requirement / Rule / Oracle

- Oracle 显式绑定 `ruleId` 与 `sourceRefs`。
- 每个 Rule 恰好绑定一个 Oracle；每个 Oracle 恰好归属一个 Rule；全部 sourceRefs 必须引用 Clause ID。
- 跨 Artifact 审计 modeled clause、Requirement、Rule、Oracle 的双向闭合。
- 测试一条规则绑定多个 Oracle、孤儿 Oracle、未知 Clause、未建模 Clause。

## Task 3：多维覆盖与 Verdict 门禁

- Coverage Obligation 显式列出 `clauseIds`、`ruleIds`、`oracleIds`。
- Verdict 覆盖事实增加 Clause disposition、Oracle、Case 三个维度。
- 从事实 Artifact 唯一派生 P0 语义完整性 finding；任一 P0 维度未闭合时返回 `artifact-blocked`，不得 accepted。
- Final Report 展示新增指标和语义追踪表。

## Task 4：Runtime Oracle Checkpoint

- Full Playwright Program 冻结 Oracle checkpoint 计划（checkpointId、oracleId、期望规范 JSON）。
- 向受控脚本只注入 Host 实现的 `checkpoint()`；Host 复算 expected/actual 摘要和 pass/fail，不信任脚本自报状态。
- 每个声明检查点必须执行一次；重复、未知、缺失、失败或无证据均使 Case 失败。
- 将检查点实际值、摘要、状态和证据引用贯穿 Runner、Runtime output、browser-results 和 Final Report。

## Task 5：三格式报告持久化

- `render-report` 在项目 `.biztest/reports/<asset>/<generation>/` 原子写入 `final-report.json`、`final-report.md`、`final-report.html` 和摘要 manifest。
- JSON 保持正式 signed Artifact；Markdown/HTML 是由该 Artifact 可复算的只读视图。
- 禁止路径逃逸、符号链接替换和读取 staging；重复渲染应得到相同摘要。

## Task 6：TodoMVC 迁移与负向 Golden

- 将 TodoMVC 真实 PRD fixture 拆为多条 Clause、Requirement、Rule、Oracle、Case 与 checkpoint，而不是单条聚合 Case。
- 至少覆盖新增、编辑、完成、过滤、清除、计数、持久化/刷新等官方行为组。
- 增加故意漏掉一个 PRD 条款或一个 checkpoint 的负向 Golden，证明最终状态不能 accepted。

## Task 7：完成验证

- 运行相关 package tests、全仓测试、build、pack dry-run。
- 运行系统 Chrome 的正式 Runtime Golden；检查三格式报告与语义追踪内容。
- 审查 diff、提交隔离分支，再按完成分支流程合入并推送。
