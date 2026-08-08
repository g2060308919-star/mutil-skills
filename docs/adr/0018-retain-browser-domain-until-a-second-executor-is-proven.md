# ADR 0018：在真实第二类 Executor 被证明前保留浏览器领域模型

## 状态

Accepted，2026-08-08。

## 背景

E2E 当前拥有 Target Probe、Preflight、Read、Reversible Write、Injection 和 Full Playwright 等多条执行路径，但它们都是同一浏览器领域内的能力。`BrowserExecutorProtocolV1` 统一的是浏览器执行适配、进度、deadline/cancellation、证据材料、cleanup 与 reconcile 语言，不是跨领域执行框架。

过早把 `Case` 改名或提升为通用 `VerificationCase` / `VerificationTask` 会把页面身份、导航、Popup、多页面、下载、Trace、Gateway 与浏览器副作用恢复等真实语义压入可选字段或类型分支。当前没有第二类生产 Executor 可以证明这些抽象边界，也没有迁移样本可以证明复杂度会下降。

## 仓库事实审计

| 决策门 | 当前证据 | 结论 |
| --- | --- | --- |
| 存在真实第二类生产 Executor | Runtime 的生产 wiring、可信 action runner 和协议均只闭合浏览器能力；没有 API、移动端、桌面端或设备 Executor | 未满足 |
| 至少 90% Browser Case 可无语义变化迁移 | 没有第二类 Executor、迁移 corpus 或等价映射 | 未满足 |
| 未迁移 Case 有明确浏览器专属原因 | 尚无迁移样本可分类 | 未满足 |
| Evidence / Assertion / Verdict / Policy 可复用 | 这些边界已经是独立领域 Artifact/Engine/Authority 能力，但这只能证明下游可复用，不能证明 Case/Executor 必须通用化 | 部分满足 |
| 抽象复杂度低于复制第二执行链 | 没有第二实现的代码量、分支数、故障模型或运行数据 | 未满足 |
| 浏览器能力不降级 | 现有 Golden 证明当前浏览器链路；没有抽象后的候选实现可比较 Popup、多页、下载、Trace、写恢复与 Cleanup | 未满足 |

## 决策

1. 保留 `DeclarativeCase`、`CompiledCase`、`BrowserExecutorProtocolV1`、`TargetContract`、页面身份和浏览器证据等现有领域命名与契约；不新增通用 `VerificationCase`、`VerificationTask` 或通用 Executor 注册表。
2. Evidence、Assertion、Verdict、Policy、Artifact publication 等已经业务中立的下游边界继续复用，但不得据此反向抹平浏览器 Case 和执行语义。
3. Probe、Read、Write、Injection 与 Full Playwright 是同一浏览器 Executor 的能力/品牌，不得按“实现数量”伪装成第二类 Executor。
4. 只有真实第二类生产 Executor 进入仓库后才能重新打开本 ADR。候选必须拥有不同于浏览器的输入、生命周期、副作用、恢复和证据语义，并能够独立执行至少一个真实验收流程；mock、接口草图、单元测试 fake 或只调用现有浏览器 backend 的 wrapper 不计入。
5. 重开时必须先提交独立抽象 Spec 和对照证明，至少包括：
   - 固定且可追踪的 Browser Case corpus，以及第二 Executor 的真实 Case corpus；
   - 至少 90% Browser Case 无业务语义变化的迁移映射，剩余部分逐项说明浏览器专属原因；
   - 旧浏览器模型与候选抽象模型的 Browser-to-Browser 对照 Golden，覆盖表单、Popup、多页面、下载、Trace、带 JSON Body 的写请求、Cleanup 与 Reload 验证；
   - Evidence / Assertion / Verdict / Policy 的字段级复用证明；
   - 类型分支、适配代码、恢复状态和测试矩阵的复杂度比较；
   - 历史 Run/Artifact 的版本化读取与回滚方案。
6. 在上述证明全部通过前，任何通用化只能作为不进入生产导出、不修改持久 schema 的一次性 prototype；不得建立兼容承诺。

## 后果

- Browser E2E 的核心术语继续准确表达真实约束，既有运行时、持久 Artifact 和报告不需要迁移。
- 新的非浏览器执行需求不能直接塞入 Browser Case；它必须先证明自己的领域模型与生产价值。
- 下游业务中立能力仍可被未来 Executor 复用，因此“不通用化 Case”不会阻止增量探索。
- 将来若出现第二 Executor，抽象工作会晚一些发生，但届时会由两套真实语义而非猜测塑形。

## 回滚 / 重开

本 ADR 没有运行时开关或数据迁移。满足第 5 条的证据后，以新 ADR supersede 本决策；新 ADR 必须列出 schema 版本、兼容读取、双轨 Golden 和回退边界。未满足决策门时不得仅因命名偏好重开。
