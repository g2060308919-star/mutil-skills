# Changelog

## [0.3.1] - 2026-07-26

### Added

- 新增固定 TodoMVC 官方 PRD 与 TypeScript+React 公网站点的完整 full-playwright Golden，覆盖表单、键盘、checkbox、路由、双击、Escape、blur、hover、持久化、Reload 和 Cleanup。
- 新增浏览器网络请求的“有序阶段、阶段内无序”模型，使并发 CSS/JS 首次请求既可审计又不会被误判越序。

### Fixed

- Discovery preflight 使用签名请求的完整资源闭包，不再只批准主文档。
- full-playwright 在 Gateway 冻结发布前关闭 program/cleanup 浏览器生命周期，避免成功请求残留 HTTPS tunnel 阻塞审计最终化。
- Gateway 子进程只跟踪完整匹配并已授权的真实传输，并将上游完成事件绑定回原始授权 requestId。
- Authority Grant 的有效期不再越过父 approval context；公开页缺少 `data-e2e-role` 时允许执行，但显式冲突仍 fail-closed。
- TodoMVC 生成资产统一绑定 `visitor` actor，确保 PRD、Requirement、Case、审批、执行身份和最终报告闭合。

### Changed

- 根包、十四个 workspace、内部依赖、Skill 安装命令与 Runtime/Engine 常量统一升级到精确 `0.3.1`。

## [0.3.0] - 2026-07-24

### Added

- `full-playwright` 正式执行 Profile：支持表单与键盘、Popup、多页面/多 Context、冻结 JSON Body 写请求、独立 Cleanup 和 Reload 验证。
- 执行批准时展示并绑定完整 `PRD 原文 → Requirement → Rule → Oracle` 语义审查，保存可追踪 `reviewDigest`。
- Authority 在可逆写批准最终化时按批准主题中的真实 resourceKey 原子配置 DataLease，精确绑定 leaseId、target fingerprint 与 fencing token；不同 Run 对同一资源真实争用。
- 跨仓发行 Golden 支持在全新 HOME 中从 workspace tarball 或 npm registry 安装，使用系统 Chrome、正式 `repo-e2e rpc` 与完整报告验证发布闭包。

### Fixed

- 执行批准后将 Authority 实际 capabilityId 绑定到 ActionMap，并冻结同一 RunBundle 供执行和最终报告复用。
- Gateway 读请求审计按 requestId 计数，不再错误退化为 capabilityId。
- Finalizer 使用真实输入 artifactId，并签署批准时冻结的 RunBundle，避免审批、执行和发布三段发生投影漂移。
- JSON Body 只从批准并冻结的 body material 渲染，Cleanup 始终使用独立浏览器上下文与受控 Gateway。
- 过期 active DataLease 的隔离状态在业务拒绝后仍独立持久化；批准恢复会重新验证全部 Lease，不能用 outbox 重放绕过过期或隔离。

### Changed

- 根包与全部十四个 workspace、内部依赖、Skill 安装命令及 Runtime 常量统一升级到精确 `0.3.0`。
- 默认本地批准仍不做身份权限管控，但每次执行必须显式确认完整语义映射和执行影响；WebAuthn 模式同样先完成语义确认，再进行用户在场认证。报告继续如实声明实际身份与职责分离保障。
- 发布前 tarball 检查与发布后 Registry Golden 分离；正式发布门强制安装并核验 npm 上全部十四个精确同版包及内部依赖。

## [0.2.1] - 2026-07-20

### Fixed

- Runtime 闭包安装显式绑定事务 staging prefix，避免与既有 Telemetry Runtime 共用父目录时 npm 向上解析并污染父级依赖。
- CLI 协议测试显式注入未安装环境，不再因开发机真实 HOME 已安装 Runtime 而进入生产执行路径。
- `create-run` 对协议允许但不符合发布 ID 格式的 requestId 使用大写摘要派生 runId，避免浏览器执行完成后才在 finalization 阶段失败。
- 跨仓发行验收不再复制被 Git 忽略的 `.tmp`，避免受信执行生成的只读临时文件阻断源码副本清理。

## [0.2.0] - 2026-07-19

### Added

- 默认使用经过完整性重验的系统 Google Chrome；托管 Chromium 保留为显式兜底。
- 每次 Run 创建、关闭并清理独立的一次性 Profile，且继续强制所有目标流量通过 Gateway。
- 默认本地确认模式与主题绑定的一次性 confirmation challenge；WebAuthn 保留为显式增强模式。
- FinalReport、Markdown 与 HTML 报告展示实际 `approvalMode`、身份验证和职责分离保障。

### Changed

- 七个 E2E package 与内部依赖统一升级为精确 `0.2.0`。
- 首次使用不再要求下载 Chromium 或登记 WebAuthn 身份；默认依次配置系统 Chrome、本地确认并运行 Doctor。

### Migration

- 旧 Run 缺少审批模式时固定迁移为 `webauthn`，避免升级后降低既有审批语义。
- 已安装的旧托管 Chromium 继续识别为 `managed-chromium`；系统 Chrome 不可用时不会静默下载或切换浏览器。
- 本地确认报告固定声明 `identityVerified=false`、`separationOfDutiesVerified=false`。

## [0.1.0] - 2026-07-16

### Added

- 用户级隔离 E2E Runtime Host、固定 `repo-e2e` 协议和空白项目运行能力。
- 独立 WebAuthn Approval Authority、HTTP/HTTPS Safety Gateway 与受控 Chromium；WebSocket/SSE 在安全桥完成前显式阻塞。
- PRD 到同代回归资产和可追踪报告的完整发布闭环。

### Fixed

- Skill 安装后仍依赖源码仓库和项目本地 E2E package 的可移植性缺陷。

### Security

- 权威执行不加载生成源码；测试进程不继承宿主秘密或项目依赖。
- 浏览器目标流量默认拒绝并强制经过 Gateway；原始证据只进入 Git 外加密 Quarantine。

### Changed

- E2E Skill 从七个低层 package capability 切换到单一 `e2e.runtime-host` 能力门。

### Migration

- 旧 E2E Skill 可继续作为文档读取；要执行受信验收，必须显式安装精确 `0.1.0` Runtime、Chromium 并完成本地 identity enrollment。
- 首发不重写既有 active generation；未知 Runtime state schema 会以 `migration-required` 阻塞。
