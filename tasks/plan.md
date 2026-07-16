# Implementation Plan：PRD 驱动 E2E 验收系统 V2

## 1. 实施目标

依据 `docs/superpowers/specs/2026-07-11-prd-driven-e2e-system-v2.md`，在现有 `mutil-skills` monorepo 中实现六个 E2E 运行时包、一个中文入口 Skill、多阶段子流程、27 类 Artifact、受控 Chromium/Gateway 执行、回归资产和同代验收报告。

实施采用 TDD 和小型垂直切片。每个任务先验证 RED，再写最小实现，最后运行局部测试、类型检查和架构检查。除专门的集成任务外，每个任务最多修改约 5 个文件。

## 2. 已确认架构决策

- 首期只支持单主机、本地文件系统和受控 Chromium。
- 使用独立 `e2e-contracts`、`e2e-engine`、`e2e-authority`、`e2e-gateway`、`e2e-playwright-runtime`、`e2e-report` 包，不污染现有业务中立 `packages/core`。
- LLM 只生成语义候选；覆盖率只针对经用户确认的结构化模型。
- 最终 Execution Approval 在只读 preflight、binding draft 和 tentative lease 之后签发。
- 可写动作由 Authority 签名 capability、Gateway 原子 reservation 和 Lease fencing 共同放行。
- 故障注入只在 Gateway 执行；Browser route 仅辅助观测。
- 生成 Playwright 使用确定性 AST/固定模板；写操作只能通过受控 launcher。
- Verdict 仅由 Engine 计算，Report 只渲染。
- requirements、regression、run、evidence 和 report 作为单 generation 提交。
- 当前仓库已有 telemetry 未提交变更；根配置只做精确追加，不覆盖或提交 telemetry 文件内容。

## 3. 依赖图

```text
基础 Envelope / Digest / Error
├─ Coverage / Workflow / Verdict contracts
├─ Authority signed grants + reservation
├─ Lease Authority + fencing
├─ Gateway canonical request + policy
├─ Artifact transaction + recovery
└─ Runtime / Report / Skill adapters

已确认模型
→ Coverage obligations
→ Cases / Action AST
→ Discovery preflight + binding
→ Execution approval + leases
→ deterministic compiler
→ controlled Chromium + Gateway
→ evidence + cleanup
→ VerdictInput
→ finalized generation
→ Markdown/HTML report
```

## 4. 实施阶段

### Phase A：安全和契约骨架

#### Task 1：接入六个 E2E workspace package

建立包目录、package manifest、tsconfig 和最小 index，追加根 TypeScript/Vitest/架构配置。

验收：六包可被 workspace 识别；依赖方向检查拒绝 Engine→Playwright 和 Report→Engine；现有测试仍通过。

验证：`npm run typecheck && npm run lint:architecture`。

风险：根配置与 telemetry 工作重叠；只追加 E2E 条目并先核对工作树差异。

#### Task 2：实现 Artifact Envelope、Canonical Digest 和稳定错误

实现 RFC 8785 JSON 摘要、文本/二进制 digest record、Artifact identity/ref 和结构化错误。

验收：相同输入摘要稳定；Unicode/换行/字段边界不会产生歧义；自身 digest/签名字段正确排除。

验证：`npm test -- --run packages/e2e-contracts/test/common.test.ts`。

#### Task 3：实现首个结构化模型与覆盖闭包

实现最小 RequirementModel、CoveragePolicy、CoverageObligation、TestCase Schema，以及只读 happy-path obligation 算法。

验收：同一确认模型生成相同 universeDigest；未确认/N/A 无决定时拒绝；关键节点必生成 obligation。

验证：`npm test -- --run packages/e2e-engine/test/coverage.test.ts`。

#### Task 4：实现权威工作流最小状态机

实现 source→scope→model→discovery→binding→execution approval→run→finalize→commit 的节点表与事件重放。

验收：所有跳步拒绝；审批主题变化回到等待状态；artifact/migration 可走非发布终态。

验证：`npm test -- --run packages/e2e-engine/test/workflow.test.ts`。

### Checkpoint A

- 六包构建和依赖边界通过。
- 摘要、覆盖和状态机都有 RED/GREEN 证据。
- 全仓库测试和类型检查通过。

### Phase B：最小只读真实浏览器闭环

#### Task 5：实现本地 Approval Authority 的只读签发与验证

实现 OS 用户本地 Authority adapter、Ed25519 grant、可信时间、撤销和 read capability 计数。

验收：篡改/过期/撤销/未知 key 拒绝；并发 reservation 只有一个成功；本地证明范围显式标记。

验证：`npm test -- --run packages/e2e-authority/test/read-grant.test.ts`。

#### Task 6：实现 Gateway canonical request 与只读 allowlist

实现 URL/payload canonicalizer、bootstrap/case 阶段、静态/read intent 和签名审计计数。

验收：未知 origin、业务 GET、redirect、非法 encoding 和超额请求 fail closed。

验证：`npm test -- --run packages/e2e-gateway/test/read-policy.test.ts`。

#### Task 7：实现确定性 Playwright 只读编译器

从严格 AST 和固定模板生成 package/config/spec/fixture/lock/toolchain manifest。

验收：无任意 import/global setup/lifecycle；`playwright test --list` 成功；Case 注解和 source integrity 一致。

验证：Runtime 编译测试和生成项目 `playwright test --list`。

#### Task 8：实现 Chromium 只读 runner 与最小证据

实现受控 launcher 的最小本地模式、页面身份、safePage、Gateway client、截图/DOM/Network 摘要。

验收：缺 Gateway/grant/sandbox health 时阻断；真实 Chromium 完成导航和只读断言；证据关联 Case/Step。

验证：Host Chromium integration test。

#### Task 9：实现最小 Verdict 和离线报告

实现 `accepted/incomplete/rejected/safety-blocked` 最小真值表、final-report JSON、Markdown 和无 CDN HTML。

验收：Verdict 可由输入独立复算；零分母为 not-applicable；HTML escape 和相对链接有效。

验证：`npm test -- --run packages/e2e-report/test/read-only-report.test.ts`。

#### Task 10：实现单 generation 最小事务发布

实现本地 OS lock、fencing counter、journal、双槽 active pointer 和最小 recovery。

验收：requirements/regression/run/report 同代；在每个关键 rename 点失败时仍选择完整 generation。

验证：`npm test -- --run packages/e2e-engine/test/artifact-transaction.test.ts`。

#### Task 11：完成只读 Golden Tracer Bullet

建立最小 Fixture App 和 PRD，从确认模型贯通真实 Chromium、Gateway、证据、Verdict 和 generation。

验收：得到 accepted 报告；回归项目可 list；修改 PRD 后 digest 和审批失效；无 LLM 也可 fresh run。

验证：`npm run e2e:golden -- --scenario read-only`。

### Checkpoint B

- 第一条真实浏览器完整闭环通过。
- 报告、回归和证据 generationId/digest 一致。
- 当前系统仍默认禁用写和注入能力。

### Phase C：写入、租约与清理闭环

#### Task 12：实现 Lease Authority 与 tentative/active lease

实现 resourceKey 唯一性、tentative→active、fencing、quarantine/release。

验收：并发独占 lease 只有一个成功；旧 fencing token 无法写；cleanup unknown 隔离资源。

#### Task 13：实现 reversible-write capability

扩展 Authority/Gateway 的多 HttpIntent、target fingerprint、payload digest、maxRequests/order 和原子 reservation。

验收：任一审批主题字段变化失效；多请求点击不能扩大授权；崩溃后 reservation 为 unknown 且不重试。

#### Task 14：实现写前后 VerificationPlan 与 cleanup

实现可观察字段、版本戳、最终一致性等待、外部副作用清单和 cleanup result。

验收：只凭 UI 未变化不能证明未写；failed/unknown cleanup 阻断 accepted。

#### Task 15：完成可恢复写 Golden 场景

Fixture App 增加审核状态转换，贯通 lease、approval、Gateway、before/after、cleanup 和报告。

验收：批准写入成功并清理；旧/并发 capability 拒绝；生产不可逆写永久拒绝。

### Checkpoint C

- reversible write 完整闭环通过。
- 所有 unknown effect 都 fail closed。

### Phase D：Gateway 故障注入与自动化诊断

#### Task 16：实现 InjectionCapability 与 Gateway 注入

实现 HTTP error/reset/timeout/empty/boundary response、精确匹配和 bootstrap/case 分阶段计数。

验收：注入目标 upstream-forwarded=0；未匹配或超额为 safety-blocked；Browser route 不产生正式结果。

#### Task 17：实现协议逃逸阻断

覆盖 Service Worker、SSE、Beacon、iframe、WebSocket read subscription、QUIC/WebRTC/file/custom scheme。

验收：所有未建模协议和客户端 WebSocket 业务帧拒绝。

#### Task 18：实现诊断分类与有界自愈

实现分类优先级、locator/wait/action/pageIdentity/evidence/matcher allowlist 和 attempt slot 选择。

验收：business failure 不重试；写 unknown 不重试；语义修改拒绝；final attempt 可由事件链复算。

#### Task 19：完成注入和自愈 Golden 场景

Fixture App 增加 500、timeout、Portal/虚拟列表和逃逸探针。

验收：real/injection 分区；零上游写证明；允许的 locator 自愈成功并可追踪。

### Checkpoint D

- Gateway 注入和协议防逃逸测试通过。
- 真实与模拟结论绝不混合。

### Phase E：完整证据、隐私和恢复

#### Task 20：实现加密 Quarantine 与证据生命周期

实现 per-run data key、Secret Provider adapter、24 小时 TTL、访问审计和 crypto-erasure。

#### Task 21：实现分类型 Sanitizer

实现 Network/DOM/Console/Screenshot/Trace 的 allowlist、format compatibility、canary 和 fail-closed。

#### Task 22：实现 ManualResult 与完整 Verdict 真值表

加入 Authority 签名 manual result、所有 Case/disposition/cleanup/evidence/gateway 状态映射。

#### Task 23：实现完整 27 Artifact Schema 与引用图审计

生成全部 JSON Schema，校验跨代、断链、重复、未登记文件和独立 verdict 复算。

#### Task 24：完成 Artifact kill-point/GC 恢复矩阵

覆盖 journal 撕裂、双槽损坏、持锁进程死亡、GC 引用竞态、磁盘满和 orphan generation。

### Checkpoint E

- 发布目录无 seeded secret；未知格式不能发布。
- 27 类 Artifact 和 generation 引用图完整。
- 所有 kill point 恢复到最后完整 generation。

### Phase F：Skill、报告和最终验收

#### Task 25：升级中文 E2E Skill 与 runtime prerequisites

按新状态机重写入口和子流程，manifest 明确 Authority/Gateway/Chromium/Contracts 能力，删除 docs-only 虚假可用性。

#### Task 26：完成报告全部章节和交互

实现全部指标、追踪表、筛选、展开、打印、证据链接和 cannot-claim。

#### Task 27：完成 30 个系统 E2E 场景

逐项实现 Spec §29 场景，真实 Host Chromium、Authority、Gateway 和 Fixture App 执行。

#### Task 28：最终架构、安全、隐私和 QA 审计

生成 SPEC-ID→实现→测试追踪矩阵，运行全部命令，清除所有 P0/P1。

### Final Checkpoint

- `npm run build`
- `npm run typecheck`
- `npm test`
- `npm run lint:architecture`
- `npm run e2e:schema:generate`
- `npm run e2e:contracts:check`
- `npm run e2e:authority:test`
- `npm run e2e:gateway:test`
- `npm run e2e:golden`
- `npm run e2e:security-golden`
- `npm run e2e:artifact-recovery`
- `git diff --check`

## 5. 实施纪律

- 每个任务先写最小失败测试，并记录 RED 的准确失败原因。
- 单任务不跨越两个独立子系统；超出 5 个文件时继续拆分。
- 每 2–4 个任务运行对应 checkpoint。
- 未完整的能力默认关闭，不能通过弱化测试提前暴露。
- 不提交或改写 telemetry 和其他用户未提交内容。
- 每个可提交增量只包含 E2E 相关文件；提交前展示 staged diff。
- 发现 Spec 缺口时先修改 Spec 并重新审批关键变化，再改代码。

## 6. 已知风险与缓解

| 风险 | 影响 | 缓解 |
| --- | --- | --- |
| 根配置与 telemetry 并行修改 | 合并冲突 | 配置接入单独任务、最小追加、逐文件复核 |
| Chromium/Gateway 网络隔离在桌面环境能力有限 | 安全 Golden 无法证明 | 受控 launcher 能力不足时 fail closed；优先 fixture/local 环境 |
| Trace/视频脱敏格式复杂 | 隐私泄漏 | 首期未知格式禁止发布；逐格式兼容矩阵 |
| 27 Artifact 一次实现过大 | 水平堆积 | 先最小闭环所需类型，再扩展并保持 envelope 兼容 |
| 系统规模超过单次会话 | 上下文丢失 | `tasks/todo.md`、SPEC-ID 和 checkpoint 持续更新 |

## 7. 计划审批门

开始 Task 1 前需确认：

1. 接受六个新 workspace package；
2. 接受首期单主机/本地文件系统/Chromium 边界；
3. 接受先完成只读 tracer bullet，再开放写和注入；
4. 接受 Authority/Gateway 作为独立进程而非 Skill 内逻辑；
5. 接受在实施期间保留并绕开当前 telemetry 未提交变更。
