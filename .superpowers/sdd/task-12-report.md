# Task 12 发行门禁报告

日期：2026-07-18
结论：**代码、打包和安全门禁已完成；真实跨仓 Chromium Golden 等待受信 Real Golden Home。**

## 已完成

- 七个 E2E workspace 包统一为精确 `0.1.0`，内部依赖无 caret、`workspace:*` 或 `latest`。
- Runtime tarball 包含固定 bin、approval assets、Python helper 与完整生产依赖；Skill 只依赖单一 `e2e.runtime-host` 能力门。
- 跨仓 driver 从干净发布副本 pack，在空白项目安装 tarball，随后使发布源码路径不可用，并以最小环境启动已安装 Runtime child。
- 安全矩阵覆盖 shell 文本、路径/链接、恶意 node_modules/Node env、SSH/env/.env canary、Gateway 绕过、审批错绑/重放/无 UV、版本与 manifest 篡改、raw evidence/path 泄漏、崩溃/effect unknown/发布 kill point、安装冲突和 state migration。
- README 与 Changelog 记录显式 Runtime/Chromium/identity/doctor 流程，以及“本地临时 Host/Gateway，不是远程后端”的边界。

## 已通过验证

- `npm pack --dry-run --workspaces`：通过。
- `npm pack --workspaces --pack-destination /private/tmp/mutil-skills-pack-qa`：通过。
- tarball 空白项目隔离安装、import、bin、doctor smoke：4/4 通过。
- `npm test`：1185 passed，25 skipped。
- `npm run e2e:golden`：24 passed，2 skipped。
- `npm run typecheck`、`npm run build`、`npm run lint:architecture`、`git diff --check`：通过。

## 唯一未执行环境门禁

当前机器没有 `E2E_RUNTIME_REAL_GOLDEN_HOME`。该目录必须包含已显式安装的 Runtime/Chromium，以及由真实受控会话生成、24 小时内有效且与 installation digest 绑定的 capability proof。禁止由测试伪造该 proof。

因此以下两项被有意跳过而非冒充通过：

- 安装后 Runtime 的真实 Chromium CLI Golden；
- tarball 空白项目、源码不可用条件下的完整跨仓 Chromium/finalize/report Golden。

配置受信 Home 后执行：

```bash
E2E_RUNTIME_REAL_GOLDEN_HOME=/absolute/trusted/home \
E2E_RUNTIME_RUN_CROSS_REPO=1 \
npm run e2e:golden
```
