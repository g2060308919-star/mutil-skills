# Full Playwright E2E 执行模式设计

## 目标

在保留现有 `trusted-read-only`、`trusted-reversible-write` 和固定 HTTP 写执行路径的同时，新增显式 `full-playwright` 模式。该模式允许冻结并审批的测试程序直接使用 Playwright `Page`、`Locator`、`BrowserContext`、`Browser`、`APIRequestContext`、`expect` 与 `testInfo` API，能够执行输入、键盘、checkbox、链接、双击、hover、多页面及其他完整浏览器交互，并生成可追踪证据、清理结果和最终报告。

用户已明确要求开放完整 Playwright API，并授权实现后持续运行真实 E2E、修复缺口、提交和推送。因此本设计把 `full-playwright` 作为显式高权限模式，而不改变已有项目的默认安全行为。

## 方案选择

### 采用方案：冻结并审批完整 Playwright 程序

`browser-action-map` 和 `execution-contract` 新增 `full-playwright/v1` 程序定义：

- `source`：测试主体 JavaScript；
- `sourceDigest`：测试主体域分离摘要；
- `cleanupSource`：无论测试成功失败都执行的清理 JavaScript；
- `cleanupSourceDigest`：清理程序域分离摘要；
- `timeoutMs`：程序总时限；
- `actionId/caseId/stepId`：追踪关系；
- `dataLeaseId/cleanupPlanId`：写入与清理绑定；
- `networkRequests`：运行所需的冻结 HTTP 请求集合。

程序在可信 Runtime 内以异步函数执行，获得只读绑定对象：

```ts
{
  page,
  context,
  browser,
  request,
  expect,
  testInfo,
  state
}
```

这使测试程序可以调用完整 Playwright API，而不需要为每一个 Playwright 方法扩展 Runtime Schema。`state` 是测试主体与 cleanup 共用的本次 Run 内存对象。

### 未采用方案一：继续枚举动作 DSL

枚举 `fill`、`press`、`check` 等动作仍无法覆盖 Playwright 的全部能力，每次新增 API 都需要升级协议，不符合用户要求。

### 未采用方案二：完全取消冻结、审批和 Gateway

直接执行任意仓库脚本会让测试无法绑定 PRD revision、审批、网络策略、证据和报告，也无法区分旧安全模式与新高权限模式。用户要求的是增强 E2E 能力，不是删除可追踪链路。

## 协议和兼容性

### Compiler Action

新增：

```ts
type FullPlaywrightCompilerAction = {
  kind: 'fullPlaywright'
  actionId: string
  source: string
  sourceDigest: string
  cleanupSource: string
  cleanupSourceDigest: string
  dataLeaseId: string
  cleanupPlanId: string
  timeoutMs: number
}
```

同一密封项目只能使用一种 Action kind。旧 `assertText` 与 `reversibleWrite` 行为不变。

### Execution Profile

所有原先枚举执行 Profile 的契约增加 `full-playwright`。Profile 必须进入：

- Regression manifest；
- Discovery subject 和 attestation；
- trusted run session；
- Compiler Input digest；
- final report 的执行事实。

### Approval Capability

`SignedWriteGrant` 增加 browser-local 可逆写 capability：

```ts
{
  transport: 'browser-local'
  operation: 'full-playwright'
  effect: 'reversible-write'
  programDigest: string
  cleanupProgramDigest: string
  dataLeaseId: string
  fencingToken: number
  cleanupPlanDigest: string
  requests: HttpIntent[]
  maxUses: 1
}
```

审批 subject 同样冻结 `transport`、`operation`、两个程序摘要和网络请求。旧 HTTP capability 保持原形并继续由固定 HTTP projector 处理。

## Compiler 与源码审计

Compiler 对 full action 生成真实 Playwright 测试：

```ts
test('CASE ...', async ({ page, context, request }, testInfo) => {
  const state = Object.create(null)
  let primaryError
  try {
    await runProgram({ page, context, browser: context.browser(), request, expect, testInfo, state })
  } catch (error) {
    primaryError = error
  }
  const evidence = await captureEvidence(page)
  const cleanup = await runCleanup({ page, context, browser: context.browser(), request, expect, testInfo, state })
  await publishResult({ evidence, cleanup, primaryError })
  if (primaryError) throw primaryError
})
```

完整程序仍由确定性 Compiler 逐字写入，Source Set digest 与 Discovery attestation 防止执行前修改。

`full-playwright` 源码审计允许所有 Playwright 对象方法，包括 `page.evaluate`、路由、多页面和 API request；仍禁止 Node host API、动态 import、`require/eval/new Function`、任意环境变量和动态包管理。该限制不削弱 Playwright 能力，只防止测试程序转变为宿主机任意代码执行。

## Runtime 执行流程

1. Runtime 从冻结资产投影唯一 full action；
2. 校验 source/cleanup digest、Action Map、Execution Contract、Run Bundle 与 SignedWriteGrant；
3. Authority 原子保留 browser-local capability；
4. Lease Authority 验证目标 lease；
5. 启动受控 Gateway 与一次性 Chrome Profile；
6. 所有浏览器和 `APIRequestContext` 网络请求只允许命中冻结规则；
7. 在固定超时内执行 source；
8. 捕获操作后 screenshot、结构化 DOM、URL、Gateway audit；
9. 在 `finally` 中执行 cleanupSource；
10. 捕获 cleanup 后状态，并要求 cleanup 返回 `verified-clean`；
11. 生成 browser-local ExecutionOutcomeReceipt，Authority complete，Lease release；
12. 如果操作效果或 cleanup 不明，mark unknown、quarantine lease，禁止自动重试；
13. 关闭 Browser/Gateway 并删除一次性 Profile；
14. 将结果交给现有 Generation Assembler、隐私处理和 final report。

## 错误和重试语义

- source 在产生副作用前失败：`proven-not-applied`，允许按现有策略有限重试；
- source 在第一项浏览器交互后异常：`unknown`，禁止自动重试；
- cleanup 抛错、超时或未返回 `verified-clean`：`unknown`，隔离 lease；
- Gateway 出现未批准请求：测试失败；如果已经开始浏览器交互，结果为 `unknown`；
- Browser 或 Runtime 崩溃：沿用 write-attempt owner marker 和恢复协议，不自动重放程序；
- 测试断言失败但 cleanup 成功：`failed + applied + verified-clean`，生成失败报告但不遗留数据。

## 证据

每个 full action 至少生成：

- 操作后 screenshot；
- 操作后结构化 DOM；
- cleanup 后 screenshot 或 DOM；
- Playwright JSON reporter Case 状态；
- Gateway signed audit；
- source/cleanup digest；
- Browser/CLI/Compiler/Source Set 测量；
- ExecutionOutcomeReceipt 与 lease receipt。

原始证据继续进入 Git 外 quarantine；仓库内只发布脱敏证据和摘要。

## TodoMVC 验收标准

固定 TodoMVC 官方提交 `ff43b02e59dfa604386bb382034b2cd07c2bcd8a` 和官方 React 网站。一个 full Playwright Case 覆盖：

1. 初始页面身份与空列表；
2. 新增三项、trim、顺序、输入清空和计数；
3. 完成、取消完成和 Clear completed 状态；
4. All/Active/Completed 路由过滤；
5. 双击编辑、Enter 保存、Escape 偏差记录、空标题删除；
6. hover 后删除；
7. 清理全部数据、reload 验证空列表；
8. Profile 删除。

固定 React 实现与 app-spec 的 Persistence、计数感叹号和 Escape 行为偏差必须出现在报告中，不能为了让测试全绿而篡改目标网站或放宽 Oracle。

## 完成条件

- Contracts、Authority、Compiler、Runtime、报告与文档测试通过；
- 原有三个执行模式回归不变；
- full Playwright 单元、集成、安全和真实 Chrome Golden 通过；
- 公开 TodoMVC 运行完成，所有可实现要求有 Case/Action/Oracle/Evidence 追踪；
- 已知产品偏差明确报告；
- npm package dry-run、build、typecheck、architecture、全量测试和 Golden 通过；
- 双轴代码审查无 P0/P1；
- 提交并推送到 `origin/codex/e2e-local-browser-approval`。
