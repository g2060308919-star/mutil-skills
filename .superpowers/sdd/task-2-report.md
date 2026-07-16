# Task 2 Report: 版本化安装、固定 Launcher 与 Source Independence

## Status

DONE

Commit title: `feat(e2e): install isolated runtime versions`

## 实现内容

- 新增固定用户级布局 `runtimeLayout(homeDir)`，将版本闭包、current pointer、安装锁、launcher、浏览器与保留状态目录放在固定的 `~/.mutil-skills` 路径。
- 新增严格 Runtime manifest：按 POSIX relative path 排序枚举除根 `runtime-manifest.json` 外的全部普通文件，记录 byteLength 与 domain-separated digest，并从 canonical records 计算 installation digest。
- manifest 创建与验证 fail closed：拒绝 symlink、socket/device、hardlink、路径越界、owner 不符、目录或文件权限放宽、未知/缺失 manifest 字段、非唯一排序与实际 bytes 不一致。
- 新增用户级精确版本安装事务：验证 `.owner.json` 与 `0700/0600` 权限、取得排他 `install.lock`、在同文件系统随机 staging 安装、固定权限、验证 package/内部依赖版本与入口 shebang、fsync、原子 rename、原子切换 `current.json`，最后更新固定 launcher。
- 相同版本仅在 installation digest 完全一致时幂等；不同 bytes、目标 symlink、unowned root、staging root 被替换、package identity/version skew 或 floating version 均拒绝。
- `ProductionClosureInstaller` 固定使用 `process.execPath + process.env.npm_execpath`，npm 参数精确为 `install --ignore-scripts --omit=dev --no-audit --no-fund --save-exact <exact-package>`；cwd 固定 staging，子进程环境仅保留 HOME/PATH/TMPDIR/registry 与必要 TLS CA 字段。
- 新增自包含固定 launcher：严格解析 `current.json` 与 manifest records，验证 manifest root digest、关键入口实际 bytes/digest/realpath/owner/mode，拒绝 `NODE_OPTIONS`、`NODE_PATH`、`--loader` 与 `--require`，以 `process.execPath` 启动绝对安装入口。
- 新增 `inspectRuntimeInstallation()`，从固定 HOME 布局重新验证完整 manifest 与 package closure 后返回由真实路径/bytes 证明的 `sourceRepositoryIndependent: true`；不会从 cwd、项目 package 或 `NODE_PATH` 解析 Runtime。
- 新增显式版本卸载：同一安装锁下复验 owner、目标 realpath 与完整 manifest；active version 必须提供已安装、同协议且完整验证的 replacement，先原子切换 current/launcher 再删除目标。
- 卸载不接受 purge 开关，并保留 state、quarantine、authority、logs 与 browsers；CLI 明确拒绝混入 `--purge-state`、`--purge-quarantine` 或 `--purge-identity`。
- CLI 新增 `install-runtime --version <exact>` 与 `uninstall-runtime --version <exact> [--activate <exact>]`；成功输出仅包含受限安装元数据，不透传 npm 输出或 cache 路径。
- package 公共入口仅新增 Task 2 的布局、安装、卸载、discovery 与闭包安装 seam；未暴露或实现 Host、Authority、Gateway 构造器。

## RED 证据

1. 初始安装安全测试：
   - Command: `npx vitest run packages/e2e-runtime/test/runtime-installer.test.ts`
   - Exit: 1。
   - Expected failure: `Cannot find module '../src/runtime-installer.js'`。
2. 完整 Task 2 首轮测试：
   - Command: `npx vitest run packages/e2e-runtime/test/runtime-layout.test.ts packages/e2e-runtime/test/runtime-installer.test.ts packages/e2e-runtime/test/runtime-uninstaller.test.ts packages/e2e-runtime/test/runtime-discovery.test.ts packages/e2e-runtime/test/protocol.test.ts`
   - Exit: 1；4 个新模块缺失，3 个 CLI 安装管理行为按预期失败。
3. 权限补强：
   - Command: `npx vitest run packages/e2e-runtime/test/runtime-layout.test.ts packages/e2e-runtime/test/runtime-installer.test.ts`
   - Exit: 1；2 tests failed / 12 passed。
   - Expected failures: group/other closure 权限尚未拒绝；已有 Runtime 的不安全祖先权限尚未复验。
4. 生产闭包与 launcher 严格性：
   - Command: `npx vitest run packages/e2e-runtime/test/runtime-installer.test.ts packages/e2e-runtime/test/runtime-discovery.test.ts`
   - Exit: 1；2 tests failed / 10 passed。
   - Expected failures: floating `packageSpec` 尚未拒绝；launcher 尚未拒绝含额外字段的篡改 manifest record。
5. 闭包完整性与 launcher 文件权限：
   - Command: `npx vitest run packages/e2e-runtime/test/runtime-installer.test.ts packages/e2e-runtime/test/runtime-discovery.test.ts`
   - Exit: 1；2 tests failed / 10 passed。
   - Expected failures: 声明但缺失的内部精确依赖尚未拒绝；launcher 尚未拒绝 group/other 可执行入口。

## GREEN 证据

- 最终 Runtime 聚焦回归：
  - Command: `npx vitest run packages/e2e-runtime/test/runtime-layout.test.ts packages/e2e-runtime/test/runtime-installer.test.ts packages/e2e-runtime/test/runtime-uninstaller.test.ts packages/e2e-runtime/test/runtime-discovery.test.ts packages/e2e-runtime/test/protocol.test.ts`
  - Result: PASS；5 files / 33 tests。
- 简报指定的 4-file 命令在最终实现中包含 21 个 Task 2 tests，均由上述最终 33-test 回归覆盖并通过。

## Typecheck / Architecture Lint

- Command: `npm run typecheck && npm run lint:architecture`
- Result: PASS；`tsc -b` 与 `scripts/check-architecture.mjs` 均 exit 0。

## 全量测试

- Command: `npm test`
- Result: PASS；95 test files passed；695 tests passed，5 skipped（700 total）。
- 按要求，提交前仅运行这一次全量 `npm test`。

## 变更文件

- `packages/e2e-runtime/src/runtime-layout.ts`
- `packages/e2e-runtime/src/runtime-manifest.ts`
- `packages/e2e-runtime/src/runtime-installer.ts`
- `packages/e2e-runtime/src/runtime-uninstaller.ts`
- `packages/e2e-runtime/src/runtime-discovery.ts`
- `packages/e2e-runtime/src/launcher-template.ts`
- `packages/e2e-runtime/src/cli.ts`
- `packages/e2e-runtime/src/index.ts`
- `packages/e2e-runtime/test/runtime-layout.test.ts`
- `packages/e2e-runtime/test/runtime-installer.test.ts`
- `packages/e2e-runtime/test/runtime-uninstaller.test.ts`
- `packages/e2e-runtime/test/runtime-discovery.test.ts`
- `packages/e2e-runtime/test/protocol.test.ts`
- `.superpowers/sdd/task-2-report.md`

## Self-review

- 安装顺序为 owner/mode → lock → same-filesystem staging → exact closure → normalize/validate → manifest → fsync → rename → current atomic write → launcher atomic write。
- current pointer 固定 runtime version、protocol major、manifest digest 与 canonical version root realpath；discovery 与 launcher 均复验绑定。
- 生产 npm 子进程不继承项目 cwd、`INIT_CWD`、`NODE_OPTIONS`、`NODE_PATH`、`npm_config_prefix` 或任意 secret；stdio 不透传 npm cache/诊断到成功 stdout。
- manifest 覆盖 package metadata、JS/JSON/native/WASM/helper 等所有普通文件 bytes；根 manifest 自身作为验证索引不进入自身摘要。
- launcher 不通过 PATH、npx、项目 package.json 或 project-local module resolution 启动 Runtime；恶意项目 package 与 `NODE_PATH` 不影响 discovery。
- active uninstall 在 replacement 验证和 current/launcher 切换成功前绝不删除当前版本；非目标持久目录没有进入删除 API 或删除路径。
- `src/index.ts` 未导出 Host facade、Authority、Gateway 或 Browser 构造器；未实现 Task 3+ Doctor/Host 业务。
- `git diff --check` PASS；未修改 plan/progress，未改动 Task 1 协议分类决策。

## Concerns

- 无阻塞 concern。
- 首期严格遵循设计范围，仅支持 POSIX owner/mode 模型与稳定三段式精确 SemVer；Doctor、Host 生命周期、Browser 安装和独立 state/identity 销毁命令留给后续任务。
