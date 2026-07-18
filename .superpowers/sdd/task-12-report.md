# Task 12 发行门禁报告

日期：2026-07-18
结论：**Task 12 的代码、打包闭包与空白项目验证已完成；发行总门禁仅剩受信任 Real Golden Home 外部环境验证。**

## 已完成

- 七个 E2E workspace 包统一为精确 `0.1.0`，内部依赖无 caret、`workspace:*` 或 `latest`。
- Runtime tarball 包含固定 bin、approval assets、Python helper、第三方许可证与完整生产依赖；Skill 只依赖单一 `e2e.runtime-host` 能力门。
- 跨仓 driver 从干净发布副本 pack，在空白项目安装 tarball，使发布源码路径不可用，再以最小环境启动已安装 Runtime child。
- 跨仓主链不再直接 import/call `runCli`；每个 RPC 都由独立子进程调用 `~/.mutil-skills/bin/repo-e2e rpc`，固定 Launcher 重新验证 active manifest、入口摘要、进程与最小环境。WebAuthn URL 实时透传给执行者完成真实在场操作。
- 已安装 Runtime 在独立子进程执行发布的 Playwright regression，并将实际 exit code、stdout/stderr digest 与 discovery attestation 写入可追踪结果；不再以固定成功值冒充执行。
- 安全矩阵覆盖 shell 文本、路径/链接、恶意 node_modules/Node env、SSH/env/.env canary、Gateway 绕过、审批错绑/重放/无 UV、版本与 manifest 篡改、raw evidence/path 泄漏、崩溃/effect unknown、发布 kill point、安装冲突和 state migration。
- README 与 Changelog 记录 Runtime/Chromium/identity/doctor 流程，以及“本地临时 Host/Gateway，不是远程后端”的边界。

## 已通过验证

- `npm pack --dry-run --workspaces`：通过。
- `npm pack --workspaces --pack-destination /private/tmp/mutil-skills-pack-qa`：通过。
- tarball 空白项目隔离安装、import、bin、doctor：5/5 通过。
- `npm test -- --reporter=dot`：159 个文件通过、1 个跳过；1266 项通过、27 项跳过。
- `npm run e2e:golden`：10 个文件、24 项通过；3 项按外部能力门跳过。
- `npm run typecheck`、`npm run build`、`npm run lint:architecture`、`git diff --check`：通过。

## 唯一未执行的外部环境门禁

当前机器没有 `E2E_RUNTIME_REAL_GOLDEN_HOME`。该目录必须包含已显式安装的 Runtime/Chromium、已登记的 WebAuthn identity，以及由真实受控会话生成、24 小时内有效且与 installation digest 绑定的 capability proof；测试禁止伪造这些事实。

因此以下验证有意跳过，而不是冒充通过：

- 安装后 Runtime 的真实 Chromium CLI Golden；
- tarball 空白项目、源码不可用条件下的完整跨仓 Chromium、finalize、published regression 与 report Golden。

配置受信 Home 后执行：

```bash
E2E_RUNTIME_REAL_GOLDEN_HOME=/absolute/trusted/home \
E2E_RUNTIME_RUN_CROSS_REPO=1 \
npm run verify:e2e-release
```

未提供该目录时，`verify:e2e-release` 必须且确实以 `E2E_RUNTIME_REAL_GOLDEN_HOME_REQUIRED` 失败，确保发行门禁不会被静默跳过。
