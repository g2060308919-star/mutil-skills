# Task 6 实施报告：Secret Broker 与一次性秘密注入

## 结果

完成 Task 6 范围：跨进程持久 Secret Broker、interactive/macOS Keychain/Linux Secret Service 三类来源、`repo-e2e secret provide` 隐藏 TTY 输入、RuntimeHost 构造依赖和普通子进程 env 隔离。未进入 Gateway、Browser 或页面注入实现。

## TDD 证据

按 RED → GREEN 分六个纵向切片推进：

1. Broker 模块不存在；新增持久化、加密、opaque handle 和重复消费测试后观察到 module-not-found RED。
2. 系统 provider 模块不存在；固定命令、输出上限、替换、signal/error/timeout 测试先 RED。
3. CLI 尚不识别 `secret provide`；真实 TTY adapter、非 TTY、Ctrl-C/EOF/read/restore/store failure 先返回旧 input error。
4. 两 Broker 实例与真实 OS 子进程并发消费；验证旧实现只有内存语义不足。
5. 同 runId 跨项目最初可读；新增失败测试后加入项目身份绑定和 wrapped-key AAD。
6. 4MiB snapshot 原先会先提交超限状态、下次读取才报 integrity failure；新增 RED 后改为 commit 前原子容量阻塞。

## 架构与安全边界

- 固定 state：`~/.mutil-skills/e2e/state/runtime-secrets.sqlite`；master key 为当前 UID、单链接、真实普通文件、`0600`，目录逐层 `0700`。
- 每 Run 随机 32-byte data key；master key 只包装 data key。secret AES-256-GCM AAD 精确为 canonical `{ runId, secretRef, providerId }`；wrapped key AAD 认证 runId 与项目 identity digest。
- snapshot strict `1.0.0`，拒绝额外字段、未知版本、非规范 base64url、错误 key、认证失败和超过 1024 entries/4MiB。首发没有旧 Secret schema，不猜测迁移。
- provide 在 SQLite `BEGIN IMMEDIATE` 中原子递增 ref version；旧 handle 失效。consume 在事务内删除 ciphertext、写 consumed tombstone并提交后才返回 Buffer。提交后崩溃可能丢失本次值，但不能二次消费。
- handle 只暴露随机 `handleId`，由当前实例 WeakMap 绑定 run/ref/provider/version；伪造、跨 Broker、跨 ref/run/project、旧 version 和重放均拒绝。
- 系统 provider 在调用前写持久 `resolving` reservation；另一进程不再读取。成功后密封为同一持久记录，缺失/失败写 consumed tombstone，不回退 env。
- macOS/Linux 仅使用固定系统工具、argv 数组、`shell:false`、最小 env、64KiB stdout/stderr 上限、10s timeout、signal/error/exit 脱敏。路径要求 canonical、root owner、单链接、不可 group/world 修改，并在 spawn 边界复验 inode。
- CLI 必须真实 TTY；raw/no-echo 在成功、Ctrl-C、EOF、读取、恢复和 Broker 失败路径恢复。主错误不被 cleanup 错误覆盖；原始 terminal/provider/CLI/plaintext/data-key Buffer 在最早边界清零。
- Runtime package 根入口不导出 Broker/provider/handle；`E2ERuntimeHost` 只接受构造依赖。普通子进程 env 仍固定 `HOME/LANG/PATH/TMPDIR`，不含 handle、value、host env 或 `.env`。

## 定向验证

```text
npx vitest run packages/e2e-runtime/test/secret-broker.test.ts \
  packages/e2e-runtime/test/secret-providers.test.ts \
  packages/e2e-runtime/test/secret-cli.test.ts \
  packages/e2e-runtime/test/environment-policy.test.ts \
  packages/e2e-runtime/test/public-exports.test.ts

Test Files  5 passed
Tests       43 passed

npm run typecheck          PASS
npm run lint:architecture  PASS
git diff --check           PASS
```

其中包含真实 OS child：子进程 A provide 后退出，两个独立子进程并发重开 Broker/consume，恰好一个成功；任何 stdout/stderr 不含 canary。

## 全量门禁

```text
npm test
  Test Files  123 passed
  Tests       909 passed | 15 sandbox skips

npm run typecheck                         PASS
npm run lint:architecture                 PASS
npm run build                             PASS
npm pack --dry-run --workspace @mutil-skills/e2e-runtime
  PASS / 104 files / 104.0 kB tarball / 507.2 kB unpacked
git diff --check                          PASS
```

默认 sandbox 的 `npm run e2e:golden` 在产品断言前环境阻塞：21 个用例因 `listen EPERM 127.0.0.1` 无法绑定 loopback，3 个用例因 Chromium MachPort/process sandbox `Permission denied/kill EPERM` 无法启动浏览器；共 24 blocked、0 个进入产品断言。本轮没有申请 elevated Golden，不能把该结果记为产品通过。Task 6 自身的真实 OS child/SQLite 并发测试在默认 sandbox 已通过。
