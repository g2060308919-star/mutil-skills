# E2E Runtime V2 架构补完实施计划

> 本计划执行已批准的 V2 补完设计；每项先写失败测试，再实现最小代码并运行相关测试。

实施状态（2026-08-09）：Task 1–6 的仓库代码、回归测试、开发机真实 Chrome 趋势证明与运维命令均已完成；Task 7 的仓库内验证、提交、推送和 PR 由本分支交付。合并后的 npm 发布、Tag/Release、Registry Golden，以及只能由运营方提供的生产 2-of-3 私钥、HTTPS TUF origin 和稳定 self-hosted runner 证明不在功能分支内伪造。

## Task 1：元数据寿命上限

- 修改 `packages/e2e-runtime/test/runtime-update-trust.test.ts`，增加四角色超过最大剩余寿命的失败样例和边界成功样例。
- 修改 `packages/e2e-runtime/src/runtime-update-trust.ts`，导出不可变角色寿命表，并在 `advanceTrustedMetadata` 中以 `updateStart` 为基准检查。
- 运行 `npm test --workspace @mutil-skills/e2e-runtime -- runtime-update-trust.test.ts`。

## Task 2：撤销事实、已有 Run 检查与审计迁移

- 在 `runtime-update-trust.test.ts` 先覆盖 v1.0 状态迁移、撤销先落盘再报错和扩展审计事实。
- 将 update state 升级为 1.1.0，新增有界 revocations 与可复核 audit facts；提供公开的状态解析和撤销判定函数。
- 在 `runtime-resolver.test.ts` 先覆盖已有 Run 的 checked、expired、offline 和 revoked 四种结果。
- 给 Resolver 增加窄接口 `existingRunRevocationChecker`；命中撤销返回 safety 类错误，生产 stable service 从持久状态构建检查器。
- 运行 Runtime update/resolver/service 三组测试。

## Task 3：Browser Executor 全路径迁移

- 在 `browser-executor-protocol.test.ts` 增加 write、injection、full-playwright shadow 的单次执行、语义等价、未知副作用 reconcile 和 mismatch 阻断测试。
- 在 `browser-executor-protocol.ts` 抽取通用 shadow 路由，并导出四类强类型路由函数。
- 在 `runtime-host.test.ts` 增加三条 Host 路由集成测试；扩展依赖配置为 read/write/injection/fullPlaywright 四个 route。
- 修改 `runtime-host.ts` 的正常执行与 full-playwright 恢复路径，统一经过协议函数。
- 运行协议和 Host 测试。

## Task 4：加权 B 端场景覆盖门禁

- 新增 `packages/e2e-runtime/src/b2b-scenario-coverage.ts` 及测试，定义版本化场景、闭环绑定、重复结果和负样本校验。
- 新增 `fixtures/e2e-b2b-coverage/` 的固定语料与期望结果，覆盖表格、过滤、分页、表单、日期、富文本、上传、权限、状态、iframe、组件。
- 新增 `scripts/e2e-b2b-coverage-proof.ts`，只从真实执行产物读取结果，输出 JSON/Markdown；跳过、缺证据、缺 Oracle 或 flaky 均使 `gateEligible=false`。
- 增加 npm script 与 CI workflow；在当前宿主运行一次并保存非门禁报告。

## Task 5：p95 与非功能门禁

- 扩展生产 benchmark schema 和测试，加入启动、更新冷/热路径、并发解析、诊断分类、证据保留指标。
- 报告记录宿主指纹、样本量、p50/p95/max、基线偏差与 `gateEligible` 原因。
- workflow 在稳定 self-hosted runner 上执行硬门禁；其他 runner 只能生成趋势 artifact。
- 当前机器运行构建和趋势证明，保存可复核报告但不冒充稳定 runner 结论。

## Task 6：生产 stable 运维工具链

- 新增 metadata bundle 预发布验证命令，检查阈值签名、寿命、版本高水位、origin/registry allowlist 和 target 身份。
- 新增撤销与 LKG 演练命令及测试 fixture；fixture key 明确只用于测试且不进入发布包。
- 更新 ADR、CONTEXT、发布 runbook 与 Golden 检查单，列清外部生产材料和激活门禁。

## Task 7：总验证与交付

- 运行格式、类型、构建、全仓测试、pack dry-run、安全检查、覆盖证明和性能趋势证明。
- 检查 npm tarball 不含测试密钥、HOME、缓存或证据原件。
- 提交并推送 `codex/e2e-v2-spec-closure`，创建 PR，等待 CI 全绿后合并。
- 合并后统一升级版本、发布 npm、创建 Git tag/release，并以全新 HOME 执行 Registry Golden。
- 生产 trusted root/origin、稳定 runner 或 npm/GitHub 权限若仍缺失，作为唯一外部阻塞项集中报告。
