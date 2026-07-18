# Changelog

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
