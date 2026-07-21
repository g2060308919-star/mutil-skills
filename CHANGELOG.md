# Changelog

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
