# E2E Runtime 真实功能验收目标调研（2026-07-21）

## 结论

推荐目标是 **TodoMVC 官方 React 示例**：

- 官方行为规格（PRD）：<https://github.com/tastejs/todomvc/blob/ff43b02e59dfa604386bb382034b2cd07c2bcd8a/app-spec.md>
- 官方仓库：<https://github.com/tastejs/todomvc>
- 官方 React 实现：<https://github.com/tastejs/todomvc/tree/ff43b02e59dfa604386bb382034b2cd07c2bcd8a/examples/react>
- 官方公开网站：<https://todomvc.com/examples/react/dist/>
- 本次源码基线：`ff43b02e59dfa604386bb382034b2cd07c2bcd8a`（2026-07-21 `master`）

它有一手行为规格、无需登录、功能面完整，并且创建、编辑、完成、过滤和删除只改变当前页面的浏览器内存状态，不产生业务 HTTP 写入。重载页面或关闭 Runtime 的一次性隔离 Profile 即可彻底清理本次数据。

但它**目前不能用于证明已发布 E2E Runtime 0.2.1 已完成完整功能验收**。原因不是目标站点不合适，而是 Runtime 当前固定动作 DSL 和生产可逆写主链不支持 TodoMVC 所需的 `fill + Enter`、checkbox、link、double-click、hover 等交互。现有只读 Golden 只能证明 PRD 摄取、审批、受控访问、证据和报告链路贯通，不能证明新增、状态变化、过滤、编辑和删除功能已被真实执行。

## 为什么推荐 TodoMVC React

TodoMVC 官方主页说明，各维护中的示例实现同一套 Todo 应用行为；当前官方 Cypress 套件以统一行为规格驱动这些维护示例：<https://todomvc.com/>。

官方 `app-spec.md` 明确定义了下列可测试行为：

1. 空列表时隐藏主列表和页脚；
2. 输入标题并按 Enter 新增 todo，输入应被清空；
3. 忽略 trim 后为空的标题；
4. 单项完成/取消完成，并同步 completed 状态；
5. 全部完成/取消全部完成；
6. 双击进入编辑，Enter 或失焦保存，Escape 放弃，空标题删除；
7. 正确显示剩余数量和单复数；
8. 删除单项；
9. 清理全部已完成项；
10. All、Active、Completed 路由过滤，并正确标记当前过滤器；
11. 将 todo 持久化到 localStorage。

规格原文：<https://raw.githubusercontent.com/tastejs/todomvc/ff43b02e59dfa604386bb382034b2cd07c2bcd8a/app-spec.md>。

React 固定源码实现了新增、更新、删除、完成、全部完成和清理已完成项等 reducer 动作：<https://github.com/tastejs/todomvc/blob/ff43b02e59dfa604386bb382034b2cd07c2bcd8a/examples/react/src/todo/reducer.js>。当前组件分别提供：

- 新增输入：<https://github.com/tastejs/todomvc/blob/ff43b02e59dfa604386bb382034b2cd07c2bcd8a/examples/react/src/todo/components/header.jsx>
- 单项完成、编辑和删除：<https://github.com/tastejs/todomvc/blob/ff43b02e59dfa604386bb382034b2cd07c2bcd8a/examples/react/src/todo/components/item.jsx>
- 列表及 Active/Completed 过滤：<https://github.com/tastejs/todomvc/blob/ff43b02e59dfa604386bb382034b2cd07c2bcd8a/examples/react/src/todo/components/main.jsx>
- 计数、过滤链接和 Clear completed：<https://github.com/tastejs/todomvc/blob/ff43b02e59dfa604386bb382034b2cd07c2bcd8a/examples/react/src/todo/components/footer.jsx>

## 当前页面身份与稳定控件

2026-07-21 对官方公开网站和官方源码的核实结果如下。动态控件应以语义角色、标签和业务状态组合定位，不应依赖列表序号或生成 class。

| 类型 | 当前值或语义定位 | 稳定 Oracle |
| --- | --- | --- |
| URL | `https://todomvc.com/examples/react/dist/` | URL origin 和固定示例路径 |
| title | `TodoMVC: React` | 页面标题精确匹配 |
| 主 heading | `h1 = todos` | heading 角色与文本匹配 |
| 新增输入 | label `New Todo Input`；placeholder `What needs to be done?` | 输入聚焦、按 Enter 后清空 |
| todo 项 | 以本次 run-id 生成的唯一标题定位 | 标题可见且顺序稳定 |
| 完成控件 | todo 行内 checkbox | `checked` 状态、父项 completed 状态、计数变化 |
| 删除控件 | todo 行内 `Delete todo` 按钮 | 对应唯一标题消失 |
| 过滤器 | `All`、`Active`、`Completed` 链接 | URL hash、selected 状态、可见项目集合 |
| 清理控件 | `Clear completed` 按钮 | 已完成项目消失，按钮在无已完成项时隐藏 |
| 静态文案 | `Double-click to edit a todo`、`Created by the TodoMVC Team`、`Part of TodoMVC` | 页面构建和身份辅助信号 |

公开页面的当前静态身份可由官方站点直接核查：<https://todomvc.com/examples/react/dist/>。官方站点没有公开部署提交证明，因此固定源码只用于复核实现能力与偏差，不能据此断言线上 bundle 与该 SHA 完全一致；正式执行时还必须记录线上 HTML/JS 响应摘要。

## 推荐功能用例

每个测试标题都必须使用唯一值，例如 `E2E-<runId>-A`，防止页面残留或并发运行造成假阳性。

### TC-01 初始状态

1. 打开官方 React 页面；
2. 断言 title 为 `TodoMVC: React`；
3. 断言 heading 为 `todos`；
4. 断言新增输入可见并已聚焦；
5. 断言列表为空，主列表和页脚隐藏。

### TC-02 新增、trim、顺序与计数

1. 新增 `E2E-<runId>-A`、`E2E-<runId>-B`、`E2E-<runId>-C`；
2. 每次新增后断言输入被清空；
3. 断言三项按输入顺序出现；
4. 断言当前 React 实现显示 `3 items left!`；同时记录它与 app-spec 示例 `3 items left` 的文案偏差；
5. 输入纯空白并按 Enter，断言列表数量不变。

### TC-03 完成、取消完成与计数

1. 勾选 B；
2. 断言 B 为 completed，A/C 仍 active；
3. 断言计数为 `2 items left!`，`Clear completed` 出现；
4. 取消勾选 B；
5. 断言计数恢复为 `3 items left!`，清理按钮隐藏；
6. 再次勾选 B，为后续过滤和清理准备状态。

### TC-04 过滤与路由

1. 点击 Active，断言 hash/selected 状态正确，只显示 A/C；
2. 点击 Completed，断言只显示 B；
3. 点击 All，断言三项全部显示；
4. 在过滤状态下完成或取消一项，断言项目立即进入或离开当前可见集合。

### TC-05 编辑

1. 双击 A 的 label；
2. 将标题改为 `E2E-<runId>-A-edited` 并按 Enter；
3. 断言新标题可见、旧标题不可见；
4. 再次编辑并按 Escape；按 app-spec 应放弃修改，但固定源码没有 Escape 分支，因此将该步骤记录为已知实现偏差，而不是通过；
5. 再次编辑为空并提交，断言该 todo 被删除。

### TC-06 单项删除与 Clear completed

1. hover C 所在行并点击 `Delete todo`；
2. 断言 C 消失；
3. 此时只剩已完成的 B，点击 `Clear completed`；
4. 断言 B 消失、列表为空、主列表和页脚再次隐藏。

### TC-07 清理确认

1. 重载页面；
2. 断言列表仍为空；
3. 关闭一次性隔离 Profile；
4. 记录 Profile 删除成功作为最终清理证据。

这里的重载用于证明测试状态已被清理，不是持久化验收。

## 数据和网络安全边界

### 功能写入

React 固定源码使用 `useReducer(..., [])` 管理页面状态，没有把 todo 发往服务端，也没有把 todo 持久化到 localStorage：<https://github.com/tastejs/todomvc/blob/ff43b02e59dfa604386bb382034b2cd07c2bcd8a/examples/react/src/todo/app.jsx>。

因此：

- 新增、编辑、完成、删除和清理只修改当前页面内存/DOM；
- hash 路由过滤只改变浏览器 URL fragment 和本地渲染；
- 不产生 POST、PUT、PATCH、DELETE 等业务 HTTP 请求；
- 页面首次加载只需要对官方站点的静态 HTML、JS、CSS 等资源执行 GET；
- 不涉及账号、Cookie 身份、共享数据或跨用户数据；
- reload、关闭页面或销毁一次性 Profile 都会清空业务状态。

Gateway 应只允许目标站点必要的同源 GET/HEAD 静态资源，拒绝非预期 origin 和所有非只读 HTTP 方法。测试不得点击 footer 中跳往站外的作者或项目链接。

### 规格偏差

官方 PRD 要求 localStorage 持久化，但 React 固定源码是页面内存状态。固定版本的官方 Cypress 也把包括 React 在内的现代重建列为 in-memory-only，并跳过 Persistence 检查：<https://raw.githubusercontent.com/tastejs/todomvc/ff43b02e59dfa604386bb382034b2cd07c2bcd8a/cypress/e2e/spec.cy.js>。

固定提交还存在两个可直接从源码确认的偏差：

- `footer.jsx` 在计数后输出感叹号，例如 `3 items left!`，而 app-spec 示例是 `3 items left`；
- `input.jsx` 只处理 Enter，没有处理 Escape，因此编辑时按 Escape 放弃修改不符合 app-spec。

因此验收报告必须将 Persistence、计数标点和 Escape 编辑行为标为 `known implementation deviation` 或失败，不能报告“TodoMVC app-spec 100% 通过”。如果目标必须包含持久化，则应选择经源码和官方测试确认仍使用 localStorage 的固定实现；不能仅依据 README 或旧注释判断。

## 当前 Runtime 能力审批

### 已有能力能够覆盖的部分

已发布 Runtime 0.2.1 可以覆盖：

- PRD 摄取和需求追踪；
- 页面 title、heading、可见文本的只读验证；
- Gateway 受控访问及审计；
- screenshot、结构化 DOM、报告和发布资产；
- 一次性隔离 Profile 的创建和销毁。

### 无法覆盖完整功能链的部分

当前 Compiler 动作模式只有 `assertText` 和 button 型 `reversibleWrite`，见 `packages/e2e-contracts/src/compiler-input.ts`。浏览器可逆写适配器只有 `clickButton(name)`，见 `packages/e2e-playwright-runtime/src/write-runner.ts` 与 `packages/e2e-playwright-runtime/src/playwright-page-adapter.ts`。

TodoMVC 完整用例至少还需要：

| 所需操作 | 当前 Runtime 0.2.1 |
| --- | --- |
| 输入文本 | 不支持 |
| 按 Enter/Escape | 不支持 |
| checkbox 勾选/取消 | 不支持 |
| link/hash 路由点击 | 不支持 |
| double-click | 不支持 |
| hover 后点击行内删除 | 不支持 |
| 按 todo 唯一标题限定操作作用域 | 不支持 |
| DOM/local-only 状态变化的生产审批与清理闭环 | 当前生产可逆写主链按 HTTP write/request/lease 建模，不能直接表达 |

另外，TodoMVC 官方页面没有 Runtime 现有 Golden 所要求的 `data-e2e-role`。若沿用响应注入适配器，必须在报告中明确它只补充测试身份标记，不得改变功能 DOM、脚本或业务行为；更合理的长期方案是让页面身份支持 title、heading、origin、ARIA 等组合证明，而不是强制外部网站提供私有属性。

因此，现在直接运行只能得到只读 smoke，不能把结果命名为“TodoMVC 功能 E2E 通过”。若通过项目外脚本绕开 Compiler/Authority/Gateway 直接调用 Playwright，虽然可以操作页面，但那也不能证明这套 E2E Runtime 的受控功能链已经工作。

## 要达到真实功能验收所需的最小 Runtime 扩展

1. 在受信 Compiler DSL 中增加语义动作：`fill`、`press`、`check/uncheck`、`clickLink`、`doubleClick`、`hover`、作用域内 `clickButton`；
2. 每个动作都从冻结的 Action Map 投影，不接受生成代码、CSS/JS 脚本或任意 Playwright 调用；
3. 为 DOM/localStorage/sessionStorage 状态变化增加独立的 `browser-local-write` effect，不冒充 HTTP reversible-write；
4. browser-local-write 的审批 subject 必须冻结 origin、页面身份、语义 locator、前置、预期后置状态、清理动作和最大操作次数；
5. 允许 UI cleanup、storage key 删除、reload 和 Profile 销毁组成分层清理策略，并为每层生成证据；
6. Oracle 增加 role、accessible name、checked、visible/hidden、count、URL hash、selected 状态，不只验证文本存在；
7. Gateway 继续拒绝所有未批准 HTTP 写；测试中的本地 DOM/storage 变化不应错误要求存在 forwarded HTTP write；
8. 使用上述 TC-01 至 TC-07 做真正的公开站点验收，并将每条 PRD requirement 映射到 action、oracle、evidence 和 cleanup receipt。

## 最终审批结论

- **目标审批：通过。** TodoMVC 官方 React 示例是一手规格对应的一手公开实现，无需账号，业务状态只存在浏览器页面内存，安全且可彻底清理。
- **规格完整性审批：有限通过。** 新增、完成、过滤、删除和多数编辑路径可测；Persistence、计数标点和 Escape 放弃编辑是固定源码的已知偏差，必须明确报告。
- **Runtime 0.2.1 完整功能验收审批：不通过。** 当前动作 DSL 和生产审批模型不能执行所需交互，任何“完整功能已验收”结论都会超出证据。
- **当前可执行结论：** 可以继续做只读 Golden/smoke；要完成用户要求的真实功能 E2E，必须先实现上述最小 browser-local-write 动作与审批闭环，再执行 TC-01 至 TC-07。
