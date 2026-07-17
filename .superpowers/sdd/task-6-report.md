# Task 6 实施报告：Secret Broker 与一次性秘密边界

## 结果

Task 6 已完成二次外审修复：建立跨 CLI/进程持久的 Secret Broker、一次性 handle、macOS Keychain/Linux Secret Service provider 与真实 TTY 隐藏输入；补齐状态完整性、项目身份、崩溃恢复、终态退役和子进程关闭边界。Task 6 不实现 Browser Bridge/page injection；真正把秘密消费到页面属于 Task 8/9。

## 最终架构

- `secret-contract.ts` 是 run/ref/provider grammar 与 64KiB、1024 entries、4MiB 上限的单一来源。
- `secret-state.ts` 负责 strict `1.0.0` envelope、HMAC、AES-256-GCM 与持久状态解析；`secret-broker.ts` 只负责 provide/resolve/consume/reservation/retire 状态机，原 738 行职责已拆分。
- Secret 不再使用独立 key 文件。Broker 复用 Task 5 `authority-state-openat.py` 与可信 Python 边界读取 `~/.mutil-skills/e2e/authority/state.key`，以 HKDF 固定域分离 wrapping/MAC key；原始 key、派生 key、Run data key 与明文 Buffer 在成功和异常路径清零。state 目录内不存在旁路 key。
- SQLite envelope 为严格 `{ schemaVersion, revision, payload, mac }`。HMAC-SHA256 覆盖 capacity 和全部 project/run/ref/version/status/attempt/expiry/tombstone/ciphertext；envelope revision 必须等于同一事务读取的 SQLite row revision。删除 tombstone、修改 reservation、增加字段或重放旧 snapshot 均 fail closed。
- Run key 是 `projectIdentityDigest + NUL + runId`；不同项目可安全共存同名 Run。Broker 不接受 caller digest，open 及每次 provide/resolve/consume/retire 都重新解析并比较 realRoot、device/inode、logicalProjectId 与 digest。
- 系统 provider 读取前写 `{ attemptId, createdAt, expiresAt, status: resolving }`。成功密封为 available；缺失/失败或崩溃过期后变 authenticated `abandoned`，同 ref 永不再次读取 provider。真实 SQLite commit-abort 回归证明 crash window 不会产生二次读取。
- consumed/abandoned tombstone 计入固定容量，只能凭 RunStore 签发的一次性私有 retirement capability 删除。capability 绑定签发 Store 的校验闭包、project/run、当前 persisted lease、不可恢复终态、Run snapshot digest 与 SQLite revision；伪造、跨项目、重放、非终态、lease/revision 变化全部拒绝。
- handle 只暴露随机 `handleId`。WeakMap 保存当前绑定；消费成功或外部已消费后删除 WeakMap，并用 WeakSet 保留稳定 `CONSUMED` 语义。跨 Broker/伪造 handle 为 `INVALID`。
- Provider 固定绝对命令、argv、`shell:false` 与最小 env。Linux 只设置从 UID 派生的 `unix:path=/run/user/<uid>/bus`，并验证 0700 UID 目录、真实 socket 及 spawn 前后 dev/inode。所有 timeout、overflow、child/stream error 与 TOCTOU abort 都执行 SIGKILL，并有界等待真实 close；kill false/no-close 返回稳定 shutdown failure。
- CLI 使用单个固定 64KiB Buffer，退格立即清零被删字节，Ctrl-D/回车结束，所有路径恢复进入前精确 `isRaw` 状态。真实 PTY 回归验证不回显、退格/Ctrl-D 与退出前恢复。
- `E2ERuntimeHost` 删除未使用的 `secretBroker` 构造依赖。普通 Runtime 子进程环境仍不含 secret/handle/host env/`.env`。

## TDD 与定向证据

修复按 state/MAC → identity/composite → reservation crash recovery → retirement capability → Provider supervisor/Linux bus → TTY/CLI 的 RED/GREEN 切片完成。

```text
npx vitest run \
  packages/e2e-runtime/test/secret-state.test.ts \
  packages/e2e-runtime/test/secret-broker.test.ts \
  packages/e2e-runtime/test/secret-retirement.test.ts \
  packages/e2e-runtime/test/secret-providers.test.ts \
  packages/e2e-runtime/test/secret-cli.test.ts \
  packages/e2e-runtime/test/secret-cli-pty.test.ts

Test Files  6 passed
Tests       57 passed
```

定向套件含真实 OS 子进程并发 Broker、真实 SQLite trigger commit-abort、真实 provider child timeout→SIGKILL→close，以及 macOS Python PTY→Node CLI 交互；不是只有 mock 单测。

## 全量门禁

```text
npm test
  Test Files  126 passed
  Tests       928 passed | 15 sandbox skips

npm run typecheck          PASS
npm run lint:architecture  PASS
npm run build              PASS
git diff --check           PASS

npm pack --dry-run --workspace @mutil-skills/e2e-runtime \
  --cache /private/tmp/mutil-skills-npm-cache
  PASS / 112 files / 112.5 kB tarball / 541.6 kB unpacked

npm run e2e:golden
  默认 sandbox：24 个在产品断言前被 loopback/MachPort 权限阻塞
  2026-07-17 提交前工作树，经 managed auto-review 批准的 require_escalated 本轮复跑：
  Test Files 10 passed；Tests 24 passed
```

全量单测的 15 个 skip 都带明确 sandbox 原因。Golden 默认 sandbox 结果仍是 24 blocked；随后同一提交前工作树经 managed auto-review 明确批准 `require_escalated`，本轮复跑 24/24 通过。该结果不等同于普通 sandbox 通过。

## 明确 residual

SQLite row revision 能识别“旧 snapshot 单独覆盖”，但不能识别攻击者把完整 SQLite 文件连同 revision 一起回滚。消除整库回滚需要 OS keychain 单调计数器、远端透明日志或其他项目范围之外的可信单调锚；本地单用户首发模型不声称具备该能力。
