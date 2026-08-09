# B 端 E2E 场景覆盖趋势证明（2026-08-09）

本次在 macOS 本机系统 Chrome 上对受控 B 端基准页执行 12 个加权场景，每个场景连续执行 3 次，共 36 次真实浏览器执行。每次均保存 Screenshot、DOM 和 Playwright Trace；上传下载、URL、Network、Console 等证据按场景额外保存或校验。

场景定义先进入正式 `compilePrdRun` 与 `buildCoverageUniverse`，执行循环只消费编译后的 Case 顺序和动作映射；Requirement、Rule、Oracle、Case ID 不由浏览器脚本另造。每个 Case 的真实变异结果独立进入 `computeVerdict`，分别要求正向 `accepted`、对应负向 `rejected`。Compiler、Coverage、执行草稿和逐 Case Verdict 由 `LocalArtifactStore` 原子发布并回读 active generation，最终执行记录同时绑定 active generation digest、已发布执行集合 digest 和已发布 Verdict 集合 digest。负向控制会篡改已验证的业务结果后重跑同一 Oracle，不使用“不存在的选择器”。

- 加权覆盖率：100%
- 能力支持率：100%
- 端到端成功率：100%
- 负样本漏报率：0%
- Flaky rate：0%
- Corpus digest：`sha256:be7a36027cafd187bd87316f838afb6569bc059f4a1ea453f5dda8db494cddf0`
- Executions digest：`sha256:828db4fa980b94953026920cbe3006293eeaee1b9a8d4f8af795819a4063db7f`
- Proof digest：`sha256:e2c06193f4441c55789ad4c12a7b55965524643cc2b97d4b09e71707fcb60a27`
- 门禁资格：`false`

门禁资格为 false 的唯一原因是本次运行来自未登记的开发机。该结论证明当前代码和系统 Chrome 可完成固定语料的真实交互闭环，但不替代稳定 self-hosted runner 的发布门禁。正式 workflow 只接受仓库内 `.github/e2e-baselines/` 中的 runner baseline 与实际 `RUNNER_NAME`、平台、架构、Node 和 Chrome channel 全部吻合；布尔环境变量不能自行获得门禁资格。

覆盖类别包括表格查询、筛选排序分页、表单校验、弹窗抽屉、日期级联富文本、上传下载、多角色权限、CRUD 状态流转、iframe/多页面/异步接口、数据清理与 reload、DOM/URL/Network/Console/截图证据，以及标准 Locator 与常见组件降级路径。
