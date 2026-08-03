# mutil-skills

面向 Agent Skill 的工程化 monorepo，围绕 schema、可复用模板、CLI 编排层、业务中立 core，以及可安装的测试基建组织代码。

## 工作区

- `packages/core`: JSON、package scripts、文件扫描、错误模型和包管理器命令构建等技术原语。
- `packages/schema`: 基于 Zod 的 `skill.manifest.json` schema、解析器、校验器和 TypeScript 类型导出。
- `packages/template`: 可复用的 foundation/testing 模板和声明式模板注册表。
- `packages/foundation`: 可安装的 `@mutil-skills/foundation` 包，只暴露 `@mutil-skills/foundation/testing`。
- `packages/skills`: 声明式 skill 集合，包含可独立安装的 TDD skill 文件。
- `packages/hooks`: Claude Code/Codex 的 MCP 与 Skill Hook 适配、统计 reducer、transcript 兜底、安装和稳定运行时。
- `packages/cli`: `repo-test`、`repo-tdd` 和兼容 CLI 包装器；Hook 业务逻辑由 `packages/hooks` 负责。

## 命令

```bash
npm test
npm run typecheck
npm run lint:architecture
```

E2E 发布先运行 `npm run verify:e2e-pack` 验证本地 tarball；发布全部 workspace 后运行
`npm run verify:e2e-release`。后者固定从 npm Registry 安装全部十四个包，并在全新 HOME、
系统 Chrome 和正式 RPC 下完成跨仓 Golden；两道门都要求零 skipped test，本地 tarball
通过不能替代公开发布验收。正式 Golden 的业务报告必须为 `accepted`；TodoMVC 公共实现
相对官方 PRD 的已知偏差由 `npm run verify:e2e-public-diagnostic` 单独验证，不会被包装成
“业务 Golden 全绿”。发布门失败会明确分类为 `environment`、`business`、`safety` 或
`release-internal`，便于区分运行环境、业务 Oracle 和门禁自身故障。发布门使用独立临时工作区；可通过 `E2E_RUNTIME_NPM_CACHE`
显式复用只含公共 tarball 的 npm 内容缓存，不复用 HOME、Runtime 状态或浏览器 Profile。

正式 npm 发布由 [`.github/workflows/publish.yml`](./.github/workflows/publish.yml) 在精确版本
Tag（`v<package.json.version>`）上执行。工作流使用 GitHub Actions OIDC 与 npm Trusted
Publishing，不读取 `NPM_TOKEN`/`NODE_AUTH_TOKEN`：先运行类型、架构、全量测试和 workspace
Golden，再按内部依赖拓扑逐包发布；相同版本只有 Registry 包与当前 Tag clean pack 的稳定文件
内容摘要一致时才允许幂等跳过，最后从 Registry 重装并运行正式 Golden。每个 `@mutil-skills/*` 包只需在 npm
Settings 中一次性登记 GitHub Trusted Publisher：仓库 `g2060308919-star/mutil-skills`、工作流
文件 `publish.yml`、允许 `npm publish`。之后发布不再需要逐包浏览器认证。
工作流在 Ubuntu 上执行全量代码验证，在固定 `macos-14` runner 上执行强制 Chromium sandbox
的系统 Chrome Workspace/Registry Golden 与 OIDC 发布；不会用 `--no-sandbox` 伪造浏览器门禁通过。

Telemetry hook 使用 `install-hooks --runtime all` 显式安装，使用 `uninstall-hooks --runtime all` 卸载；安装后 runtime 位于用户目录，不依赖当前 checkout。第一期默认不保存或上传事件，详细口径见 [统计说明](./docs/telemetry-hook-statistics-guide.md)。

本实现统一使用的包 scope 是 `@mutil-skills/*`。
仓库和每个发布包均按根目录 `LICENSE` 中的 MIT License 授权，并在 npm 元数据中声明
`license: MIT`。

## PRD 驱动 E2E 验收

E2E Skill 负责从 PRD 编排需求、审批、受控浏览器执行、证据和报告；`@mutil-skills/e2e-runtime` 提供确定性状态机与安全执行边界。Skill 与 Runtime 分开安装，安装 Skill 不会隐式下载或启动 Runtime。

首次使用按以下顺序准备：

1. 安装 Node.js 22.13.0 或更高版本。Runtime 仅支持 macOS/Linux；`doctor` 会在业务执行前
   分别报告 Node、平台、临时目录、Chrome 与 Gateway 等环境问题。
2. 使用你的 Agent Skill 安装器安装 `packages/skills/skills/testing/e2e` 中的 E2E Skill。
3. 用户显式安装精确版本 Runtime：

   ```bash
   npm exec --yes --package=@mutil-skills/e2e-runtime@0.5.1 -- repo-e2e install-runtime --version 0.5.1
   ```

4. 验证并选择本机系统 Google Chrome。Runtime 只使用 Chrome executable，并为每次 Run 创建全新的一次性 Profile：

   ```bash
   ~/.mutil-skills/bin/repo-e2e configure-browser --system
   ```

   如果系统 Chrome 不可用，用户可以显式运行 `~/.mutil-skills/bin/repo-e2e install-browser` 安装并选择托管 Chromium 作为兜底。

5. 使用默认本地确认模式：

   ```bash
   ~/.mutil-skills/bin/repo-e2e configure-approval --mode local-confirmation
   ```

   默认模式无需身份登记。需要验证自然人身份和职责分离时，显式改用 `webauthn`，再运行 `identity enroll` 登记审批身份。

6. 运行环境诊断；只有 `ready: true` 才能开始受信验收：

   ```bash
   ~/.mutil-skills/bin/repo-e2e doctor --json
   ```

7. 进入用户项目，让 Agent 调用 E2E Skill 并提供 PRD 路径。所有状态转换都通过固定 launcher 的 JSON stdin/stdout RPC 完成，不从用户项目解析 Runtime package。
8. 验收完成后，在该项目的 `.biztest` 目录查看可追踪测试资产、脱敏证据与最终报告；Git 外原始证据不会作为报告资产发布。

### 运行边界

- Runtime Host、Approval Authority 和 Safety Gateway 都是按需启动的本地临时进程，不是需要部署或维护的远程后端。
- 当前版本默认支持 macOS/Linux 上经过验证的系统 Google Chrome，并保留托管 Chromium 兜底；未执行 Firefox/WebKit 时，报告不能宣称跨浏览器通过。
- 首个版本只对显式审批闭包内的 HTTP/HTTPS、逐跳 Redirect 和 Beacon 提供生产执行。WebSocket 与 SSE 在缺少转发前逐帧/流终态桥时固定 `safety-blocked`，不会连接上游，也不能被报告为已覆盖。
- Runtime 安装、浏览器选择和产生副作用的确认都必须由用户显式触发。Doctor 不会代替用户安装或修复环境。
- 每个 Run 的一次性 Chrome Profile 与日常 Profile 完全分离：不会读取或改变日常 Cookie、历史、扩展、缓存、账号登录或已打开页面；浏览器正常关闭后删除，异常残留由 Runtime recovery 按 owner marker 清理。
- 本地确认只证明同一 Runtime 调用者明确同意当前主题，不验证自然人身份或职责分离；最终报告会显式展示这一保障边界。
- Skill 缺少 Runtime 时仍可读取文档和梳理 PRD，但不得执行 Case、生成审批或发布验收资产。
