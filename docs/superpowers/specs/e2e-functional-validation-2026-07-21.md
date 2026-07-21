# E2E Skill 公开目标功能验证报告（2026-07-21）

## 验证结论

本轮**能力边界验证已经完成**，但用户要求的完整 E2E 功能验收尚未完成。

已经以真实系统 Chrome 证明：

1. npm 公共仓库安装的 Runtime 能在仓库外项目通过确定性 Golden harness 完成 PRD 摄取、测试 Authority 自动审批、Gateway 受控访问、证据、报告与资产发布闭环；
2. 真实公开网站能在一次性隔离 Profile 中完成按钮交互、状态断言、反向恢复和 Profile 删除；
3. 仓库内受控可逆写 Golden 能完成真实 Chrome 点击、HTTP 写、效果验证、cleanup、Lease 释放和 27 项资产的 accepted 报告；
4. effect unknown 路径能阻止自动重试并发布 safety-blocked 事实。

尚未被证明、且 Runtime 0.2.1 当前确实不能执行的是：从公开 TodoMVC PRD 自动生成并执行新增、勾选、过滤、双击编辑、删除等完整浏览器功能用例。当前 Compiler 和生产 Runtime 缺少所需语义动作，并且生产可逆写主链只接受固定 HTTP 写，不能把纯 DOM/页面内存变化表达为受控写。

因此，不能对外宣称“E2E Skill 已支持任意 PRD 的完整浏览器功能验收”“标准 Skill 用户审批流程已通过”或“TodoMVC 完整功能 E2E 已通过”。可以准确宣称的是：**发布安装、Golden harness 驱动的只读 PRD 闭环、真实浏览器基础交互和 HTTP 可逆写安全闭环已分别通过；标准用户审批流程和通用多动作浏览器功能编排尚未完成。**

## 公开目标与一手规格

### 业务功能目标：TodoMVC React

- 官方行为规格：<https://github.com/tastejs/todomvc/blob/master/app-spec.md>
- 官方仓库：<https://github.com/tastejs/todomvc>
- 官方实现：<https://github.com/tastejs/todomvc/tree/master/examples/react>
- 官方网站：<https://todomvc.com/examples/react/dist/>

选择理由、稳定控件、7 组功能用例和实现偏差见 [目标调研](./e2e-functional-target-research-2026-07-21.md)。TodoMVC React 无需登录，业务变化只存在页面内存/DOM，重载和销毁隔离 Profile 即可清理；但完整功能需要 `fill`、键盘、checkbox、link、double-click、hover 和作用域定位，超出 Runtime 0.2.1 的动作面。

### 真实交互目标：W3C WAI-ARIA Disclosure Card

- 官方模式：<https://www.w3.org/WAI/ARIA/apg/patterns/disclosure/>
- 官方示例：<https://www.w3.org/WAI/ARIA/apg/patterns/disclosure/examples/disclosure-card/>

W3C 规格明确要求 Disclosure 按钮以 `aria-expanded=false/true` 表达折叠和展开状态，并由按钮控制对应内容。该目标无需账号，不产生业务 HTTP 写，适合验证真实公开页面的按钮交互与本地恢复。

## 执行结果

### A. npm 公共安装后的跨仓 PRD 闭环

- Runtime：`@mutil-skills/e2e-runtime@0.2.1`
- 安装摘要：`sha256:61190affc0c2e3749bf8c8b25aff277248c8a4f5d43bee619d1d5bfc0eacbf59`
- 浏览器：系统 Google Chrome `150.0.7871.129`
- 目标：TodoMVC JavaScript ES5 官方源码固定页面
- Run：`RUN-TODOMVC-1784644365703-B25FDA688D20CA12-CREATE-CROSS-REPO`
- 结果：`accepted`
- final-report 内容摘要：`sha256:d533932e5d8133cc0d2f67996db4da829e564a9d875908fa288472d601df89f9`
- final-report 文件 SHA-256：`a7794425d5afeb400a8a6436267606eb877e0b479eec1a14dc75eb1b02d55cc1`
- Gateway：forwarded `1`，blocked `6`
- 发布回归：exit code `0`

该结果使用测试 Authority 和确定性自动确认，不是用户通过 E2E Skill 面对 `confirmation-required` 后亲自确认的标准流程。它证明公开 npm Runtime 包能在仓库外项目中运行，不证明 Skill 可替用户审批，也不证明 TodoMVC 的新增、编辑、删除、过滤和持久化。

### B. W3C 公开网站真实功能交互

执行步骤：

1. 为系统 Chrome 创建独立临时 Profile；
2. 打开 W3C 官方 Disclosure Card 页面；
3. 校验 title 和主 heading；
4. 校验首个 Details 按钮初始 `aria-expanded=false`；
5. 点击按钮，等待官方 CSS 动画结束；
6. 校验 `aria-expanded=true`，受控区域高度由 `15px` 变为 `504px`，详情正文可读；
7. 再次点击，校验 `aria-expanded=false`，高度恢复为 `15px`；
8. 关闭 Chrome Context 并删除一次性 Profile。

结果：

- 页面身份：通过；
- 初始折叠：通过；
- 展开与正文 Oracle：通过；
- 反向恢复：`verified-clean`；
- Profile 删除：通过；
- 总体：`passed`；
- 浏览器：系统 Google Chrome `150.0.7871.129`；
- 目标响应：HTTP `200`，`Last-Modified: Mon, 20 Jul 2026 08:05:33 GMT`；
- 可复现命令：`node scripts/e2e-w3c-disclosure.probe.mjs`；
- 探针源码 SHA-256：`82528f2b8424e0e2fb7bcac0a25dd88bb5c6c60dfbbc47c712e3d9e304f10aef`；
- 脱敏结构化结果：[e2e-w3c-disclosure-probe-result-2026-07-21.json](./e2e-w3c-disclosure-probe-result-2026-07-21.json)；
- 展开态截图 SHA-256：`d8112317cf4f377ca3cf20ea41c46bf42a42697e9096728504c29fdf70366cfa`。

原始截图只保存在 Git 外的临时验收目录，没有提交进仓库。本项证明真实公开网页行为和隔离清理可用，但它是补充浏览器功能探针，没有绕称为 Runtime 的 accepted 代际。

### C. 受控可逆写与未知副作用 Golden

执行命令：

```text
npx vitest run --config vitest.e2e.config.ts scripts/e2e-write.golden.test.ts --reporter=verbose
```

真实回环 Gateway、Authority、Lease、系统 Chrome 和 Fixture App 在沙箱外受控启动，结果：

- `executes and cleans a real browser write before publishing an accepted 27-artifact generation`：通过；
- `写响应断连导致副作用 unknown 时永久阻断重试并发布 safety-blocked 事实`：通过；
- Test Files：`1 passed`；
- Tests：`2 passed`；
- 总耗时：`10.01s`。

该结果证明 button 型浏览器动作与 HTTP 可逆写安全闭环确实工作；Fixture 是仓库 Golden，不是外部公开业务网站。

### D. 仓库回归验证

- `npm test -- packages/skills/test/e2e-skill.test.ts packages/e2e-playwright-runtime/test/write-runner.test.ts packages/e2e-runtime/test/runtime-write-projector.test.ts --reporter=dot`：`57 passed`；
- `npm run typecheck`：通过；
- `npm run lint:architecture`：通过；
- `npm test -- --reporter=dot` 第一次在外层受限沙箱内执行：`1334 passed`、`27 skipped`、`2 failed`；
- 两个失败都来自 macOS `sandbox-exec` 无法在外层沙箱中再次应用策略；
- 在允许原生 `sandbox-exec` 的环境中执行 `npx vitest run packages/e2e-runtime/test/regression-publisher.test.ts packages/e2e-runtime/test/sandboxed-one-shot-executor.test.ts --reporter=verbose`：`6 passed`。

因此没有产品回归失败；第一次全量运行的两个失败是执行环境嵌套沙箱限制，已用同一提交、同一测试在正确权限边界内复验通过。

## 失败边界的源码证据

当前发布实现的关键限制：

- `packages/e2e-contracts/src/compiler-input.ts` 的 Compiler Action 只有 `assertText` 与 button 型 `reversibleWrite`；
- `packages/e2e-playwright-runtime/src/playwright-page-adapter.ts` 的写动作只有 `clickButton(name)`；
- `packages/e2e-runtime/src/runtime-write-projector.ts` 要求生产写映射为 `runtime-fixed-http/v1`，且 locator、wait、script 都必须为空；
- 生产写必须闭合 write request、effect probe、cleanup request、verification probe 四个固定 HTTP intent；
- TodoMVC React 的业务变化不产生 HTTP 写，因此不能伪造 forwarded write、Lease 或 cleanup receipt 来通过安全门。

这不是测试数据或环境问题，而是 Runtime 0.2.1 的协议能力边界。直接在仓库外写 Playwright 脚本虽然能操作 TodoMVC，但会绕过 Compiler、Authority、Gateway、资产和报告链，不能作为 E2E Skill 完整通过证据。

## 后续完成标准

只有同时满足以下条件，才能把总体结论升级为“完整功能通过”：

1. 冻结协议增加受控 `browser-local-write`，不与 HTTP write 混淆；
2. 支持 `fill`、`press`、`check/uncheck`、`clickLink`、`doubleClick`、`hover` 和父项作用域内点击；
3. Oracle 支持 checked、visible/hidden、count、URL hash、selected 和输入值；
4. 审批 subject 冻结语义 locator、前置、后置、最大次数和清理策略；
5. cleanup 能证明 UI 清除、reload 后无残留和 Profile 删除；
6. 使用调研文档的 TC-01 至 TC-07，通过 Runtime RPC 生成同一 accepted 代际；
7. 每条 PRD requirement 都能追踪到 Case、Action、Oracle、Evidence 和 cleanup receipt。

## 最终判定

| 验证对象 | 判定 |
| --- | --- |
| Skill/Runtime 公共安装 | 通过 |
| Golden harness 驱动的仓库外 PRD→资产→报告只读闭环 | 通过 |
| 标准 Skill 用户审批流程 | 未验证：Golden 使用测试 Authority 自动确认 |
| 真实公开网站按钮交互与隔离清理 | 通过 |
| HTTP 可逆写安全闭环 | 通过 |
| effect unknown 防重试 | 通过 |
| TodoMVC 多动作完整功能链 | 不通过：能力未实现 |
| 任意 PRD 的通用浏览器功能验收 | 不通过：不能由现有证据支持 |

**总体判定：能力边界验证已完成，E2E Runtime 0.2.1 有限通过；用户要求的完整 E2E 功能验收未完成。**
