# B 端 E2E 场景覆盖趋势证明（2026-08-09）

本次在 macOS 本机系统 Chrome 上对受控 B 端基准页执行 12 个加权场景，每个场景连续执行 3 次，共 36 次真实浏览器执行。每次均保存 Screenshot、DOM 和 Playwright Trace；上传下载、URL、Network、Console 等证据按场景额外保存或校验。

这次复跑不再由脚本直接绕过 Runtime 组件：场景由正式 `compilePrdRun` 和 `buildCoverageUniverse` 生成；每轮 repetition 使用独立 Run、Scheduler 队列、Gateway、Attempt 与 Reservation；每个 Attempt 在浏览器执行前由 Authority reserve 并记录 started，执行后 Gateway 将含 `runId + caseId + actionId + attemptId + outcomeDigest` 的已消费终态 reservation 写入自身签名且已验签的 publication；浏览器动作经 `BrowserExecutorProtocolV1` 分派，协议结果绑定 Screenshot、DOM、Trace 的 URI 与摘要；系统 Chrome 流量实际经过对应 Run 的 Runtime Gateway；Browser outcome digest 进入 Authority/Gateway terminal outcome 的规范摘要，proof 会跨三方复算并拒绝结果拼接；随后由 `selectFinalAttempt` 验证后进入该轮 `computeVerdict`。三份完整正向 Verdict、逐 Case 负向 Verdict、执行集合和 219 份证据文件均进入同一 active generation 并逐字节回读验摘要。

- 加权覆盖率：100%
- 能力支持率：100%
- 端到端成功率：100%
- 负样本漏报率：0%
- Flaky rate：0%
- Runtime 执行链：Scheduler、Authority、Gateway、Browser Executor 全部接通
- Corpus digest：`sha256:be7a36027cafd187bd87316f838afb6569bc059f4a1ea453f5dda8db494cddf0`
- Executions digest：`sha256:7a8126b77308468ce91b7b1405dee7273bfcbca1d4eca5d181c80b4cebc5c311`
- Generation digest：`sha256:0e2189c2082240bdeb4b8fd6d22da3b53d0532d1a1a07e9e6ccd79ff0f6764b9`
- Proof digest：`sha256:ebbbdea81797236c9649ce63aff375c7b156c9b5e0301ec77db37e4cdb3d3de5`
- 覆盖证明：`passed=true`
- 发布门禁资格：`gateEligible=false`
- 唯一门禁未满足原因：`ENVIRONMENT_NOT_APPROVED`

`gateEligible=false` 不代表业务能力失败。它只表示本次结果来自未登记的开发机，不能冒充稳定 self-hosted runner 的发布硬门禁。正式 workflow 仍只接受仓库 `.github/e2e-baselines/` 中的 runner baseline 与实际 `RUNNER_NAME`、平台、架构、Node 和 Chrome channel 全部吻合的证明。

覆盖类别包括表格查询、筛选排序分页、表单校验、弹窗抽屉、日期级联富文本、上传下载、多角色权限、CRUD 状态流转、iframe/多页面/异步接口、数据清理与 reload、DOM/URL/Network/Console/截图证据，以及标准 Locator 与常见组件降级路径。任何 Runtime 链路缺失、skip、缺证据、generation 不一致、集合替换、负向漏报或 flaky 都会使证明失败。
