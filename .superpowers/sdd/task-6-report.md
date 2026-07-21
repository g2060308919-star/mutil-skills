# Task 6 实施报告：Secret Broker 与一次性秘密边界

## 结果

Task 6 已完成三次外审修复：建立跨 CLI/进程持久的 Secret Broker、一次性 handle、macOS Keychain/Linux Secret Service provider 与真实 TTY 隐藏输入；补齐认证退役、终态 Run 锁序、provider 完成后复验、明文最早清零和资源清理边界。Task 6 不实现 Browser Bridge/page injection；真正把秘密消费到页面属于 Task 8/9。

## 最终架构

- `secret-contract.ts` 是 run/ref/provider grammar 与 64KiB、1024 entries、4MiB 上限的单一来源。
- `secret-state.ts` 负责 strict `1.0.0` envelope、HMAC、AES-256-GCM 与持久状态解析；`secret-broker.ts` 只负责 provide/resolve/consume/reservation/retire 状态机，原 738 行职责已拆分。
- Secret 不再使用独立 key 文件。Broker 复用 Task 5 `authority-state-openat.py` 与可信 Python 边界读取 `~/.mutil-skills/e2e/authority/state.key`，以 HKDF 固定域分离 wrapping/MAC key；原始 key、派生 key、Run data key 与明文 Buffer 在成功和异常路径清零。state 目录内不存在旁路 key。
- SQLite envelope 为严格 `{ schemaVersion, revision, payload, mac }`。HMAC-SHA256 覆盖 capacity 和全部 project/run/ref/version/status/attempt/expiry/tombstone/ciphertext；envelope revision 必须等于同一事务读取的 SQLite row revision。删除 tombstone、修改 reservation、增加字段或重放旧 snapshot 均 fail closed。
- Run key 是 `projectIdentityDigest + NUL + runId`；不同项目可安全共存同名 Run。Broker 不接受 caller digest，open 及每次 provide/resolve/consume/retire 都重新解析并比较 realRoot、device/inode、logicalProjectId 与 digest。
- 系统 provider 读取前写 `{ attemptId, createdAt, expiresAt, status: resolving }`。成功密封为 available；缺失/失败或崩溃过期后变 authenticated `abandoned`，同 ref 永不再次读取 provider。真实 SQLite commit-abort 回归证明 crash window 不会产生二次读取。
- consumed/abandoned tombstone 计入 1024 secret-entry 容量。退役不再删除 Run，而是移除 wrapped key/ciphertext 并写 authenticated Run 级 `retired` marker；provide/resolve/consume 全部拒绝，provider 不会再次读取。marker 不计 1024 entry，但仍永久计入 4MiB snapshot；达到总上限后 fail closed，未来回收必须与 Run 终态归档/销毁共同证明。
- retirement capability 绑定 project/run、当前 persisted lease、不可恢复终态、Run snapshot digest 与 SQLite revision，采用 available/in-progress/used 状态。RunStore 在 `BEGIN IMMEDIATE` 中复验并执行 SecretStore 幂等 callback；callback/commit 失败恢复 available，成功才 used。两个 SQLite 库不存在单一原子事务，安全性来自固定 RunStore→SecretStore 锁序、持锁复验和幂等重试。
- Broker 生产默认打开 RunStore。provide/consume 在短 active-run transaction callback 内完成；系统 provider 先在 active 校验下提交 resolving，释放 RunStore 后读取外部系统，返回后再 active 校验并密封。期间 Run 若终态化，只写 abandoned 并清零 provider Buffer，不返回 handle。
- handle 只暴露随机 `handleId`。WeakMap 保存当前绑定；消费成功或外部已消费后删除 WeakMap，并用 WeakSet 保留稳定 `CONSUMED` 语义。跨 Broker/伪造 handle 为 `INVALID`。
- Provider 固定绝对命令、argv、`shell:false` 与最小 env。Broker 默认在 darwin 装配 Keychain、Linux 装配 Secret Service，未知平台保持 unavailable，显式测试注入覆盖默认且永不回退 env。Linux 只设置受验证的 `XDG_RUNTIME_DIR=/run/user/<uid>` 与对应 D-Bus address。所有 timeout、overflow、child/stream error、可执行文件复验异常与 TOCTOU abort 都执行 SIGKILL 并有界等待 close；child 已 fulfilled 后 postcheck 失败也清零已生成的明文 Buffer，并统一返回稳定的 Provider 边界错误码。
- CLI 使用单个固定 64KiB Buffer，在读取 TTY 前完成 Broker open；provide 返回后的第一个 finally 立即清零，再执行 close 和 stdout。退格立即清零被删字节，Ctrl-D/回车结束，所有路径恢复进入前精确 `isRaw` 状态。真实 PTY 通过可信 Python discovery 在 macOS/Linux 运行，只有可信 Python 或 PTY 能力明确缺失才 capability skip。
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
Tests       68 passed
```

定向套件含真实 OS 子进程并发 Broker、真实 SQLite trigger commit-abort、真实 provider child timeout→SIGKILL→close，以及 macOS Python PTY→Node CLI 交互；不是只有 mock 单测。

## 全量门禁

```text
npm test
  Test Files  126 passed
  Tests       938 passed | 15 sandbox skips

npm run typecheck          PASS
npm run lint:architecture  PASS
npm run build              PASS
git diff --check           PASS

npm pack --dry-run --workspace @mutil-skills/e2e-runtime \
  --cache /private/tmp/mutil-skills-npm-cache
  PASS / 112 files / 115.4 kB tarball / 554.8 kB unpacked

npm run e2e:golden
  当前三次外审工作树默认 sandbox：24 个在产品断言前被 loopback/MachPort 权限阻塞
  未再次申请 elevated；9f08208 旧基线的 24/24 elevated 结果不代表本次改动
```

上述全量 `938 passed` 是最终 inspector edge patch 前、同一工作树主修复版本的门禁结果；没有把它记作最终差异的全量复跑。最终 inspector delta 另由 provider `20/20`、六文件 focused `68/68`、`npm run typecheck -- --pretty false` 与 `git diff --check` 覆盖。

全量单测的 15 个 skip 都带明确 sandbox 原因。当前改动的 Golden 默认 sandbox 结果为 21 个 loopback `EPERM` 与 3 个 Chromium MachPort/process `EPERM`，均在产品断言前阻塞；没有把它们记作产品通过，也没有复用旧基线的 elevated 结果。

## 明确 residual

SQLite row revision 能识别“旧 snapshot 单独覆盖”，但不能识别攻击者把同一 namespace 行的 `{ revision, snapshot }` 成对回滚；完整 SQLite 文件回滚只是该攻击的一个特例。消除这种回滚需要 OS keychain 单调计数器、远端透明日志或其他项目范围之外的可信单调锚；本地单用户首发模型不声称具备该能力。retired marker 永久计入 4MiB snapshot 也是明确容量 residual；当前选择到顶 fail closed，不做会恢复 provider 可读性的无证明裁剪。
