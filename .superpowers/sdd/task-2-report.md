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

## Review Fix Follow-up

Commit title: `fix(e2e): harden runtime installation transactions`

### 修复内容

- 将激活事务改为先快照旧 launcher/current，再原子准备并验证与版本无关的固定 launcher，最后原子切换 current；launcher 或 current 即使在实际写入后报错，也分别恢复旧 bytes/mode。
- 安装事务显式跟踪本次 rename 的 version target；versions 父目录 fsync、post-rename 完整验证、launcher 准备或 current 激活失败时，仅在 inode 与本事务 staging identity 一致时删除 target，并 fsync 父目录，因此同版重试不会被残留阻塞。
- 新增内部生产依赖 seam `installRuntimeWithOperations()` / `RuntimeInstallerOperations`，只从非 package-root source 测试入口使用；测试在真实临时 HOME 和真实文件 bytes 上注入 I/O 边界故障，不断言 mock 调用。
- uninstall 在验证或删除任何目标前先调用 `verifyCurrentRuntimeInstallation()`，完整复验 current 的严格 schema/protocol major、version root realpath、manifest digest 与实际 installation；schema 合法但绑定不一致时 fail closed。
- discovery 与 uninstall 共用相同 current binding verifier，消除两条路径的验证漂移。
- 固定 launcher 在 realpath 前对 versions root 与目标 version 分别 lstat，拒绝 symlink，验证当前 UID 与目录 `0700`，并要求 canonical version root 是 versions root 的严格子目录。
- 新增显式 platform gate，仅允许 `darwin`/`linux`；`freebsd`、`aix`、`win32` 即使具有 `getuid` 也返回 `E2E_RUNTIME_PLATFORM_UNSUPPORTED`。launcher 内嵌相同允许集合。
- CLI 与 manifest 现在共用 `isExactRuntimeVersion()`，关闭 exact-version 双来源 minor；自包含 launcher 仍内嵌同一固定 regex，避免从项目或 package resolution 加载代码。
- 未实现或修改 Doctor、Host、Browser、Authority 或 Gateway 业务。

### RED

1. 安装激活 rollback 与 rename 后清理：
   - Command: `npx vitest run packages/e2e-runtime/test/runtime-installer.test.ts`
   - Exit: 1；3 failed / 9 passed。
   - Expected failures: `installRuntimeWithOperations` 尚不存在；launcher 写后失败、current 写后失败、versions fsync 失败无法进入所需事务 seam。
2. uninstall current binding：
   - Command: `npx vitest run packages/e2e-runtime/test/runtime-uninstaller.test.ts`
   - Exit: 1；1 failed / 4 passed。
   - Expected failure: schema-valid current 的 `versionRoot` 指向另一 installation 时，旧实现仍删除 inactive target。
3. launcher 目录边界：
   - Command: `npx vitest run packages/e2e-runtime/test/runtime-discovery.test.ts`
   - Exit: 1；4 failed / 3 passed。
   - Expected failures: symlinked versions、symlinked version、`0755` versions/version 和 resolved versionRoot 等于 versions root 时，旧 launcher 均错误启动 trusted entrypoint。
4. 显式平台 gate：
   - Command: `npx vitest run packages/e2e-runtime/test/runtime-layout.test.ts`
   - Exit: 1；1 failed / 5 passed。
   - Expected failure: `assertSupportedRuntimePlatform` 尚不存在。

### GREEN

- 安装事务聚焦：`npx vitest run packages/e2e-runtime/test/runtime-installer.test.ts`
  - PASS；13/13 tests。
  - 覆盖 launcher/current 写后故障 rollback、versions fsync 故障清理与重试、post-rename verification 故障清理与重试。
- 最终必需聚焦门禁：
  - Command: `npx vitest run packages/e2e-runtime/test/runtime-layout.test.ts packages/e2e-runtime/test/runtime-installer.test.ts packages/e2e-runtime/test/runtime-uninstaller.test.ts packages/e2e-runtime/test/runtime-discovery.test.ts packages/e2e-runtime/test/protocol.test.ts`
  - PASS；5 files / 43 tests。

### Typecheck / Architecture Lint

- 首次 typecheck 捕获测试 helper 的隐式 `any`（TS7031），补充 `InstallRuntimeOptions` 显式类型后重跑。
- Command: `npm run typecheck && npm run lint:architecture`
- Final result: PASS。

### Self-review / Concerns

- current 是激活事务的最后一项持久状态切换；其后的读取仅验证刚写入的 canonical pointer，失败会回滚 current 与 launcher。
- rollback 对 current 与 launcher 分别 best-effort 执行；任一 rollback 自身失败会以 `E2E_RUNTIME_ACTIVATION_ROLLBACK_FAILED` 保留原始错误与 rollback errors，避免静默成功。
- 新 target 清理核对 rename 前 staging directory 的 dev/ino，不会删除同路径上的未知 replacement。
- current binding mismatch 在 target manifest 验证和删除之前拒绝；两个 version 目录在测试中均保持存在。
- launcher 集成测试通过真实 executable 构造 symlink-resolved 且 current 绑定匹配的攻击布局，证明拒绝来自 lstat/mode/strict-child gate，而不是偶然的 current mismatch。
- `git diff --check` PASS；未修改 plan/progress，未运行全量 `npm test`，符合 review 指令。
- 无阻塞 concern。
