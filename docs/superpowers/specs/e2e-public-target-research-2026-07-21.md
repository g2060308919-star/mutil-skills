# 公开 PRD 与可验证网站候选调研（2026-07-21）

## 调研目标与边界

为 E2E Runtime 的真实跨仓验收选择一个公开目标，要求：

- 有官方或一手维护的应用规格、需求说明或标准文档；
- 有与规格对应的公开网站；
- 无需登录即可完成只读验收；
- 不点击会产生服务端写入的控件，不创建账号、内容或评论；
- 页面 `title`、`h1/h2/h3` 和可见文案足够稳定，可以形成可追踪断言；
- 来源只采用官方仓库、官方规格和目标网站。

页面数据于 2026-07-21 使用隔离的无头 Google Chrome 实时读取；检查动作仅包括打开页面、读取 DOM 与可见文本，没有提交表单或触发业务写入。

## 候选一：TodoMVC Ember.js 示例（推荐）

### 一手来源

- 官方应用规格：[TodoMVC Application Specification](https://raw.githubusercontent.com/tastejs/todomvc/master/app-spec.md)
- 官方项目仓库：[tastejs/todomvc](https://github.com/tastejs/todomvc)
- 对应公开网站：[TodoMVC Ember.js 示例](https://todomvc.com/examples/emberjs/todomvc/dist/)

官方应用规格明确规定：无待办事项时主列表与页脚隐藏；新待办事项从顶部输入框录入；待办支持完成、编辑、删除、计数、清除已完成、持久化与路由。这是一份真正面向应用行为的公开规格，而不只是项目介绍。

### 当前页面实测标识

- `title`：`TodoMVC`
- `h3`：`Ember.js`
- `h1`：`todos`
- 稳定可见文案：`Double-click to edit a todo`
- 稳定可见文案：`Part of TodoMVC`
- 初始页面还显示框架说明与官方资源链接。

### 建议的只读验收用例

本次只验证应用初始态，不创建待办事项：

1. 打开官方示例 URL；
2. 断言页面标题为 `TodoMVC`；
3. 断言存在 `h1` 文本 `todos`；
4. 断言可见文案包含 `Double-click to edit a todo`；
5. 断言可见文案包含 `Part of TodoMVC`；
6. 不填写输入框、不按 Enter、不点击任何会改变 localStorage 的控件。

### 优势与风险

优势：

- PRD/应用规格与公开实现由同一官方项目维护，来源关系最清晰；
- 初始页面无需登录，验收完全只读；
- `h1` 和两段静态说明文案稳定，不依赖后端 API 返回内容；
- 应用规模小，失败时容易定位是网络、浏览器、Gateway、身份绑定还是页面断言问题。

风险：

- 页面标题只有 `TodoMVC`，没有包含 `Ember.js`，需要同时使用 `h3=Ember.js` 或 URL 绑定来区分实现；
- 应用具备 localStorage 持久化能力，因此必须使用 Runtime 的隔离 Profile，避免历史数据污染初始态；
- 公开页面没有 E2E Runtime 约定的 `data-e2e-role`。若当前协议强制角色绑定，需要使用只改变 HTTP 响应、不修改上游仓库的可信适配器注入角色标识，并在报告中披露；不能把注入结果伪装成上游原生能力；
- 若后续验证“新增/编辑/删除”等功能，会写入隔离 Profile 的 localStorage。该写入不会影响服务端，但应在一次性 Profile 销毁后清除。

## 候选二：RealWorld Conduit 演示站

### 一手来源

- 官方规格与项目仓库：[realworld-apps/realworld](https://github.com/realworld-apps/realworld)
- 官方公开演示站：[RealWorld Conduit Demo](https://demo.realworld.show/)

官方仓库声明所有前后端实现遵循共同 API 规格，并提供共享 E2E 测试套件；公开演示站由官方项目链接，使用隔离的演示后端。

### 当前页面实测标识

- `title`：`Conduit`
- 稳定可见导航：`Home`、`Sign in`、`Sign up`
- 稳定可见说明：`This is the Angular frontend demo from the Realworld project.`
- 稳定可见说明：`This demo is connected to a demo backend that enforces session isolation.`
- 稳定可见分区：`Global Feed`
- 首次 DOM 就绪时存在一个空 `h1`；文章加载后出现若干文章标题 `h1`，文章标题来自动态数据。

### 可执行的只读验收用例

1. 打开首页；
2. 断言 `title=Conduit`；
3. 断言上述两段演示站说明可见；
4. 断言 `Global Feed` 可见；
5. 不进入登录/注册，不点赞、不关注、不发文章或评论。

### 风险

- 首页内容依赖远端 API，可能短暂显示 `Loading articles...`，失败原因可能来自目标后端而非 E2E Runtime；
- 页面缺少稳定且有文本的应用级 `h1/h2/h3`，当前文章标题是动态数据，不适合作为长期页面身份；
- 站点有登录和写操作，虽然本次不触发，但攻击面和误操作风险高于 TodoMVC；
- 同样没有 Runtime 约定的 `data-e2e-role`；
- 因动态后端和标题不稳定，不建议用于发布阻断型 Golden 验收，可作为后续网络/异步页面的扩展验收。

## 候选三：W3C WAI 页面结构——Headings

### 一手来源

- 官方标准教程页面：[Headings | W3C WAI](https://www.w3.org/WAI/tutorials/page-structure/headings/)
- 官方页面源文件入口：[w3c/wai-website 中的 headings.md](https://github.com/w3c/wai-website/edit/main/pages/design-develop/tutorials/page-structure/headings.md)
- 页面关联的 WCAG 成功准则由该页面直接列出，包括 1.3.1、2.4.1、2.4.6 和 2.4.10。

### 当前页面实测标识

- `title`：`Headings | Web Accessibility Initiative (WAI) | W3C`
- `h1`：`Headings`
- `h2`：`Overview`
- `h2`：`Heading ranks`
- `h3`：`Exception for fixed page sections`
- `h2`：`Organize passages of text`
- `h2`：`Headings that reflect the page organization`
- `h3`：`Main heading before navigation`
- `h3`：`Main heading after navigation`
- 稳定可见文案：`Headings communicate the organization of the content on the page.`

### 可执行的只读验收用例

1. 打开官方教程页面；
2. 断言完整页面标题；
3. 断言 `h1=Headings`；
4. 断言 `h2=Heading ranks`；
5. 断言上述介绍文案可见；
6. 不点击邮件、GitHub 编辑或新建 Issue 链接。

### 风险

- 页面静态、稳定、无需后端，作为浏览器/Gateway/报告链路冒烟目标非常可靠；
- 但其需求来源是网页内容标准和教程，不是典型业务应用 PRD，无法代表表单、交互状态或业务流程覆盖；
- 页面页脚年份等内容会随年份变化，不应作为断言；
- 同样没有 Runtime 约定的 `data-e2e-role`。

## 选择结论

推荐使用 **TodoMVC Ember.js 示例** 完成本次真实验收。

理由是它同时具备官方应用规格、官方公开实现、稳定初始页面标识、无登录和无需后端数据的特点。它比 W3C 页面更接近“PRD 驱动应用 E2E”，又比 RealWorld 更少受到动态 API 和内容漂移影响。

本次 Golden 验收应明确限定为“公开 PRD 到只读初始态断言”的完整链路验证，证明：PRD 摄取、需求映射、计划生成、受控浏览器访问、Gateway 约束、证据采集、报告生成和资产发布能够贯通。它不能单独证明 TodoMVC 规格中的新增、编辑、删除、过滤、路由和持久化功能全部覆盖；如果要声称完整覆盖，必须在隔离 Profile 内补充这些交互场景，并逐条建立需求到测试与证据的追踪关系。

## 对 Runtime 验收协议的特别提示

三个公开目标都没有原生 `data-e2e-role`。若当前 Runtime 把该属性作为强制身份绑定条件，本次可采用响应层可信适配器，只为送入浏览器的 HTML 增加角色标识；必须同时满足：

- 不修改上游网站或克隆仓库的源文件；
- 适配器逻辑与摘要进入验收资产；
- 报告明确区分“上游原始页面事实”和“测试适配器注入事实”；
- 页面标题、标题层级与业务文案仍直接来自上游页面；
- 不借助适配器伪造本应由产品实现的业务功能或业务结果。

长期改进方向是让 Runtime 支持对无角色属性的第三方只读公开页面使用“URL + title + heading + oracle”组合身份策略，而不是要求所有外部目标都修改 DOM；该策略应由规格显式定义，并保留严格模式供受控业务系统使用。
