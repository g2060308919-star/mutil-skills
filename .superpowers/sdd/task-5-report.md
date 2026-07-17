# Task 5 实施报告：WebAuthn 用户在场审批与 Authority Host 控制面

## 结果

完成。实现范围严格限制在 Task 5：WebAuthn identity/session、loopback 审批页、Authority 子进程控制面、Runtime Authority adapter、`identity enroll` / `approve --run-id --type` 与 `open-approval` 用户在场流程，以及 WebAuthn receipt 最终化为现有 Authority SignedGrant 并进入既有 RPC verify/reserve 边界；未实现 Task 6 之后的 Secret Broker、Gateway 或浏览器执行。

基线提交：`7f8c27c fix(e2e): invalidate released run locks`

初始结果提交：`680a7cb feat(e2e): require user presence for runtime approvals`

外审修复提交：`19b4043 fix(e2e): bind runtime approvals to verified presence`

## TDD 证据

按 RED → GREEN 推进，过程中观察到的 RED 包括：

- WebAuthn 用户在场模块尚不存在；
- Authority snapshot 尚无持久 credential repository；
- loopback 审批 server 尚不存在；
- 固定浏览器 bundle 复制脚本尚不存在；
- Authority process handle 尚无 enrollment/approval 控制方法；
- Runtime Authority Host 尚不存在；
- Runtime Host 的 `open-approval` 尚未接线；
- CLI 人类审批命令返回未实现；
- 生产类曾可被错误测试构造器实例化；新增失败测试后改为 module-private construction key；
- 未登记的 enrollment subject 曾被接受；新增失败测试后绑定配置的 `e2e-approver` identity。

## 实现摘要

### WebAuthn Authority

- 固定 RP ID `localhost`，验证精确 origin；registration/authentication 均要求 user verification。
- registration 固定 `attestationType: 'none'`、算法 `[-7, -257]`。
- challenge 使用 32 字节随机数，最长 5 分钟，第一次 completion 尝试即消费。
- session 绑定 `runId`、approval type、subject digest、Runtime installation digest 和 origin。
- 生产路径直接调用 `@simplewebauthn/server@13.3.2` 的官方验证器；验证替身仅存在于测试文件的模块 mock 中。
- credential 保存 `id/publicKey/counter/transports/subject`；注册使用原子 insert，认证使用完整旧值 CAS，counter 必须严格递增。
- credential 列表作为 Authority `2.1.0` snapshot 的 AES-256-GCM 密文持久化，使用固定版本 AAD；SQLite 原始 bytes 不出现 credential ID、公钥或 subject 明文。真实旧版 `2.0.0` 通过事务迁移，未知版本和非精确结构失败关闭。
- 认证完成只在 Authority child 内生成绑定 subject/run/type/digests/origin/expiry 的一次性 receipt；公开 session ID 不能充当 receipt，绑定不匹配、过期和重放均失败。

### Loopback 审批页

- 只监听 `127.0.0.1` 随机端口，公开 origin 固定为 `http://localhost:<port>`。
- 每个 session 生成 32 字节随机 bearer，只放入 URL fragment；页面立即清除 fragment，不使用 query 或 Cookie。
- 只提供 Runtime package 内的固定静态 bytes；不读取 cwd、用户项目或 CDN。私有 `/session` 和 `/submit` 使用规范 base64url `Authorization: Bearer`，并按 session 隔离。
- bearer 先执行规范编码检查，再使用 `timingSafeEqual`；非规范但解码为相同 bytes 的别名也会拒绝。
- POST 要求精确 origin、JSON content type、正文不超过 64 KiB；错误 bearer、非 loopback、过期和第二次提交均拒绝。
- 所有响应设置 `cache-control: no-store`、CSP、`nosniff` 和 `no-referrer`。
- 页面只用 `textContent` 展示 Authority 生成的不可编辑规范摘要。

### 资源供应链

- 固定 `@simplewebauthn/browser@13.3.0`。
- 固定 UMD bundle SHA-256：`cf4469953efcb5617a870ae3f022b3ad48aee8c06012ccdafcabc73058f123a0`。
- build 时校验 package name/version、source realpath、source digest、target realpath 和 target digest，再原子复制。
- Runtime 运行时通过 `import.meta.url` 定位资源，并再次验证 bundle digest。

### Authority 子进程与 Runtime

- Authority child 独占 HTTP/WebAuthn response 和一次性认证 receipt；parent 只可创建 session、读取 URL/session ID、等待 completion。
- IPC 不传 `credentialResponse`、`approved` 或认证 session ref。
- Authority shutdown 撤销未消费 challenge 并关闭全部 loopback server。
- Runtime production 启动路径调用随 npm 包交付的 Python helper，以逐层 `openat`/`mkdirat`、dirfd 和 `O_NOFOLLOW` 创建或打开 current-UID 的 0700 authority state 目录，并以 dirfd、`O_EXCL/O_NOFOLLOW`、nlink=1、0600、精确 32 bytes 读写 state key。父进程再只读打开最终目录并核对 dev/inode/realpath；Authority child 继承该 fd，经 `fchdir` 后 `exec` Node，SQLite 只使用相对 basename 且在打开前后复验目录身份。目录替换竞态失败关闭，不修改诱饵目录或密钥，也不在诱饵中创建 SQLite。
- approval subject digest 覆盖 Run、asset、approval type、project identity、Runtime installation、workflow 和 artifact digests。
- `open-approval` 在等待用户期间不持有 Run lease；callback 后重新解析项目物理/逻辑身份，再重新获取 lease、重新读取 Run、重算绑定，发生变化即拒绝。
- RPC payload 不能携带 credential response、subject digest、installation digest 或 `approved`；CLI 要求显式 `--type`，把 bearer URL 输出到 stderr，stdout 只报告 `status: verified`，不伪造领域审批结果。默认 RPC 仅对 `open-approval` 启动真实 Authority，并保证关闭。

## 验证结果

计划要求的核心聚焦集：

```text
npx vitest run packages/e2e-authority/test/webauthn-user-presence.test.ts \
  packages/e2e-authority/test/webauthn-approval-server.test.ts \
  packages/e2e-runtime/test/authority-host.test.ts

Test Files  3 passed (3)
Tests       15 passed (15)
```

进程隔离、资源和 RPC 聚焦集：

```text
npx vitest run packages/e2e-authority/test/authority-execution-rpc-host.test.ts \
  packages/e2e-runtime/test/approval-assets.test.ts \
  packages/e2e-runtime/test/protocol.test.ts

Test Files  3 passed (3)
Tests       18 passed (18)
```

全量测试在 Task 5 完成后只执行一次：

```text
npm test

Test Files  107 passed (107)
Tests       795 passed | 10 skipped (805)
```

10 个 skip 均来自受限 sandbox 中不能监听 loopback/启动子进程的环境分支；相应 Task 5 loopback 与真实 child 套件已在允许本机回环监听的环境单独执行并通过。

其余验证：

```text
npm run typecheck                                  PASS
npm run lint:architecture                          PASS
npm run build --workspace @mutil-skills/e2e-runtime PASS
npm pack --dry-run --workspace @mutil-skills/e2e-runtime PASS（86 files，包含审批页、WebAuthn bundle 和复制脚本）
git diff --check                                   PASS
```

## 安全自审结论

- 生产代码没有可注入假 WebAuthn verifier 的公开 factory；测试 seam 未从 package entrypoint 导出。
- Runtime parent 无法提交 WebAuthn response 或伪造 `approved: true`。
- 用户在场完成只代表认证 session 已验证；Task 5 不提前推进 workflow，不伪造 Task 8 的领域 grant。
- bearer、challenge、credential 私有状态与 state encryption key 均未写入普通 stdout/响应结果。
- 未发现跨越 Task 5 边界的实现或需要人工批准的残留修改。

## 外审修复附录

本轮逐项关闭 2 个 Critical 与 8 个 Important：

1. **C1 生产 CLI/RPC 接线**：默认 `rpc open-approval` 启动真实 `RuntimeAuthorityHost`，URL 只写 stderr，完成/失败后关闭；其他 RPC 命令不启动 Authority。
2. **C2 私有绑定 receipt**：公开 `sessionId` 不再等价于认证引用；receipt 只留在 Authority child，绑定 subject、runId、approval type、subject/runtime installation digest、origin、签发/过期时间，精确匹配后先删再返回，过期/错绑/重放失败。
3. **I1 身份重验**：用户在场返回后重新解析项目身份并核对 digest、realRoot、device/inode 和 logicalProjectId，再重新获取 Run lease。
4. **I2 显式审批类型**：人类命令固定为 `approve --run-id <id> --type <type>`，只校验 type 是否适用于当前 workflow，不再猜测。
5. **I3 原子 credential 状态**：登记使用 insert，认证 counter 使用完整 credential CAS，严格要求 `newCounter > oldCounter`；并发重复登记/认证只有一个成功。
6. **I4 子进程生命周期**：每个 session 只允许一个 waiter；child error/exit/disconnect 有界拒绝所有 waiter并清理状态；终态 close 幂等。
7. **I5 会话 TTL/settle**：成功、失败、超时、显式关闭共用一次 settle；真实 timer 到期撤销 challenge、清空 bearer/session payload 并关闭 server。
8. **I6 snapshot 迁移**：Authority 当前版本提升至 `2.1.0`；真实旧 `2.0.0` 在 SQLite transaction 内迁移，未知版本/多余字段/缺失字段失败关闭。
9. **I7 状态文件系统加固**：逐级 fd/lstat/fstat/realpath/dev/inode/UID 校验目录；key 使用 no-follow、exclusive create、nlink=1、0600、精确长度和 fd 读写；symlink、hardlink 与真实目录替换 TOCTOU 均拒绝且不修改 canary。
10. **I8 bearer 隔离**：bearer 仅通过 fragment 交付，页面立即清除；私有接口仅接受规范 base64url Authorization bearer，不使用 query/Cookie，跨 session 与非规范编码别名均拒绝。

额外安全审阅修复：二次目录身份校验不得在确认 inode 相同前执行 `chmod`；base64url bearer 必须 canonical round-trip，防止同一 secret 存在多个字符串别名。

本轮验证证据：

```text
合并聚焦集（8 files）                        54/54 PASS
受影响授权签发/校验集（8 files）             39/39 PASS
目录 symlink/hardlink/TOCTOU 安全集            3/3 PASS
bearer 非规范别名 RED: 200，修复后 GREEN: 401
npm run typecheck                              PASS
npm run lint:architecture                      PASS
npm run build --workspace @mutil-skills/e2e-runtime PASS
npm pack --dry-run --workspace @mutil-skills/e2e-runtime PASS（86 files）
git diff --check                               PASS
```

## 二次外审修复附录

二次外审的 2 个 Critical 与 7 个 Important 已逐项落实：

1. **旧状态迁移原子性**：`2.0.0` snapshot 在同一 SQLite transaction 内先完成严格顶层/嵌套结构解析、五把私钥解密、Grant 与 Attempt 签名验证，再生成并提交 `2.1.0`。错误密钥测试证明 SQLite snapshot bytes 与 revision 完全不变，随后使用正确密钥仍可成功迁移。
2. **receipt 绑定归属**：六种 Grant API 均移除 `approvalSessionBinding`。Authority 先验证并冻结真实 Grant subject，按 `approval-subject/v1` 重算 digest，再内部派生 `{ subject, approvalType, subjectDigest }`；私有 receipt 精确匹配后一次性消费。Subject A receipt + Subject B 实际签发的攻击回归已失败关闭。
3. **统一项目身份复验**：新增共享 `assertSameProjectIdentity()`，同时比较 realRoot、device、inode、logicalProjectId、digest；RPC 与人类审批路径均覆盖物理目录替换和逻辑 projectId 重绑。
4. **惰性 Authority**：Authority factory 只在 global replay miss 的新 `open-approval` 内调用。即使 factory 已故障，已完成请求仍从持久 ledger 重放，且 factory 调用数不增加。
5. **cleanup 单响应**：Authority 与 Run Store 独立尝试关闭并聚合错误，cleanup 完成前不写 stdout；任一或两个 close 失败都只输出一个 `E2E_RUNTIME_CLEANUP_FAILED`。如果 Host success 已经持久化而 cleanup 失败，本次返回 cleanup error；同 requestId 后续重放返回持久 success 且不启动 Authority。这是“持久幂等结果优先、当前传输报告资源回收失败”的明确权衡。stdout writer 在第一次写入前标记 started；即使底层 Writable 部分写入后拒绝，也不会追加第二份 JSON，只返回 70。
6. **公共入口收口**：`@mutil-skills/e2e-runtime` 根入口只导出 Runtime 协议 Schema、对应类型和版本；Host、Authority、Run Store、安装器等 trusted facade 不再公开，`package.json.exports` 只有 `.`。
7. **强文件系统落点**：新增 `authority-state-openat.py` 和 `authority-child-fchdir.py`，均由 Runtime tarball 的 `scripts` 自包含交付。deterministic 竞争测试覆盖 helper 后 parent pin 前替换，以及 child 继承 fd 后路径已重绑；诱饵目录 mode 不变，且没有 key/approval.sqlite/lease.sqlite。
8. **权限错误分类**：受限 sandbox 禁止 loopback 时，原始 `EPERM/EACCES` 被转换为稳定的 `E2E_APPROVAL_PLATFORM_PERMISSION_DENIED` safety error，不泄露底层路径或异常文本。

二次外审未扩大 Task 5 的业务范围，也未实现后续 Secret Broker、Gateway 或 Browser 执行。

二次外审验证证据：

```text
整合聚焦集（15 files）                    91 passed / 4 sandbox-loopback skipped / 0 failed
sandbox 外真实 child/loopback 聚焦          4 passed / 0 skipped / 0 failed
npm run typecheck                           PASS
npm run lint:architecture                   PASS
npm run build --workspace @mutil-skills/e2e-runtime PASS
npm pack --dry-run --workspace @mutil-skills/e2e-runtime PASS
                                               88 files；包含两个 Python helper
git diff --check                            PASS
```

按二次外审要求未重复执行仓库全量测试；受影响的 Authority 签发、迁移、WebAuthn、Runtime CLI/Host、项目身份、SQLite 绑定、真实 child 与发布包均已包含在上述聚焦集和门禁中。

## 三次外审修复附录

三次外审撤销了二次外审的“三字段 receipt binding 足够”结论，并补齐以下边界：

1. **唯一审批主题域**：新增严格六类 Grant subject union；Runtime `open-approval`、人类 `--subject-file` 和 Authority 六个签发入口统一使用 `e2e-canonical-approval-subject/v1`，拒绝额外字段和跨类型 subject。
2. **完整、持久、一次性回执**：WebAuthn 回执保存 subject、runId、type、subject/install digest、origin 和时间边界；credential counter CAS 与回执插入同事务，回执以独立 AAD 的 AES-256-GCM 密文进入 Authority `2.2.0` snapshot。签发在 Grant transaction 内 take 回执并把完整 `approvalContext` 纳入 Grant 签名；重启后可消费一次，再次消费失败。
3. **迁移重放**：`2.0.0/2.1.0 → 2.2.0` 在提交前重放 Attempt context、sequence、previous chain、时间、状态转换、最终 chain 和 reservation attestation；删除或重排事件保持原 snapshot bytes/revision 不变。
4. **可移植可信 Python**：不再硬编码 `/usr/bin/python3` 或读取 `PATH`。固定候选逐个验证 root owner、不可由 group/world 修改、内容摘要、版本与 dir-fd 能力；每次 helper/child spawn 前复验，Doctor 的 Authority/Artifact FS probe 记录证明摘要，无兼容解释器时稳定阻塞。
5. **生命周期闭合**：人类审批 Authority/Run Store 使用 `Promise.allSettled` 独立清理；Authority child 采用 shutdown→TERM→KILL 有界回收；启动失败、终态错误和父目录 fd 关闭失败均不会遗留 child。
6. **文件系统持久性**：openat helper 在创建每级目录、创建/删除 key 后 fsync 包含目录；SQLite leaf 通过 `O_NOFOLLOW` 预开并验证 regular/nlink=1/UID/mode/fd-path identity，使用 fd chmod 后再由 native SQLite 打开和复验。测试证明替换 leaf 后 fail closed 且不写替换文件。
7. **敏感字节生命周期**：WebAuthn POST 正文与所有 chunk、helper stdout、state/session key Buffer 在最早可行的 finally 中清零；child/parent IPC 配置中的 base64 key 在序列化/解码后立即覆盖。

### 明确残余边界

Node `DatabaseSync` 只接受 pathname，不能把预验证 fd 直接交给 SQLite VFS。因此 current-UID 的 0700 state 目录内，同 UID 主动进程仍可能竞争替换 basename。当前实现会在 native open 后检测 rebound、关闭数据库并拒绝继续初始化，测试确认替换文件 bytes 不变；但在引入可靠 fd-backed VFS 之前，不宣称完全消除这一同账户主动竞态。

旧附录中的 `2.1.0` 与三字段描述仅代表历史审查状态，不再是当前架构结论。

### 三次外审最终门禁

```text
npm run typecheck                              PASS
npm run lint:architecture                      PASS
npm run build                                  PASS
npm test                                       110 files / 822 passed / 13 sandbox skips / 0 failed
npm run e2e:golden（允许 loopback/Chromium）    10 files / 24 passed / 0 skipped / 0 failed
npm pack --dry-run --workspace @mutil-skills/e2e-runtime
                                                PASS / 92 files / 82.1 kB
git diff --check                               PASS
```

13 个常规测试 skip 是受限 sandbox 中明确标记的 loopback、真实 child 或受控浏览器分支；相同能力已由沙箱外黄金门禁完整执行，不能把环境 skip 误记为产品通过。发布包确认包含审批静态页、WebAuthn bundle、`trusted-python` 编译产物以及两个 Python helper。

最终五轴自审额外关闭了 SQLite native open 后任一校验/建表/close 异常时 pinned leaf fd 未必回收、Injection/WebSocket/SSE 签发冻结请求后仍二次读取原始 TTL getter、Discovery/Execution 缺少 `--subject-file` 仍可能进入注入 Authority，以及 cleanup 错误覆盖原始操作错误四个问题。修复后资源均独立回收，主错误与 cleanup 错误可聚合追踪，命令在启动 Authority 前 fail closed，并新增 TTL getter 与命令语法回归测试。

## 四次外审修复附录

本轮关闭执行期上下文、旧授权迁移、敏感内存和启动清理四类问题：

1. RPC Server 在 `registerClient` 时保存可信 approvalContext，并在 child 实际消费 WebAuthn receipt 时更新；operation 只读取服务端注册元数据，不接受 payload 自报。Parent/client 只携带 Runtime 已知的 run/install/type/subjectDigest，origin/issued/expires 仍由 Server exact 校验；Authority/Runner/Gateway 分别交叉校验 type、subject/digest、Run、installation、origin 和时间边界。
2. 真实无 `approvalContext`、使用旧签名域的 `2.0.0/2.1.0` Grant 可先通过旧结构与签名校验；迁移随后清空授权派生状态并写入 revoked tombstone，旧 Grant 必须重新审批。
3. WebAuthn/RPC/helper/Python 的原始流 chunk、RPC Server/Client 长期 session key、PKCS8 明文均有最早可行的清零路径；RPC client/server 提供显式幂等 `destroy()`，HTTP 与 Golden 生命周期已接线。
4. Authority child 启动失败后的 stop 若再次失败，返回同时保留 startup/cleanup 两个 cause 的 `AggregateError`，有界 shutdown→TERM→KILL 不变。

最终门禁：

```text
npm run typecheck                              PASS
npm run lint:architecture                      PASS
npm run build                                  PASS
npm test                                       111 files / 826 passed / 13 skipped / 0 failed
npm run e2e:golden（允许 loopback/Chromium）    10 files / 24 passed / 0 failed
npm pack --dry-run --workspace @mutil-skills/e2e-runtime
                                                PASS / 92 files / 82.2 kB
git diff --check                               PASS
```

## 五次外审修复附录

本轮关闭生产最终化、真实 legacy digest、部分启动清理和生产测试注入四类问题：

1. **C1 production receipt→Grant chain**：Runtime/CLI 打开审批时只向 child 发送可信四字段；WebAuthn 完成后才提交严格 Grant subject。child 在 Authority transaction 中一次性消费 receipt、签发 SignedGrant 并注册 RPC Server 的完整 approvalContext；完成前、subject 重绑定及重放均拒绝。Runtime 复验 Authority 返回的四字段 binding，并把 SignedGrant 与 binding 持久化进 Run Store。Golden 已改为用真实 P-256 WebAuthn assertion 串接 receipt→finalize→SignedGrant→RPC verify/reserve，不再依赖测试上下文注入。
2. **I1 真实旧状态迁移**：`2.0.0` 与 `2.1.0` fixture 使用旧 `approval-subject/v1` subject digest 与旧签名 payload；迁移代码先按该旧域验证，再撤销旧 Grant。fixture 不再用当前 canonical digest 冒充 legacy 状态。
3. **I2 部分启动聚合清理**：Authority child 在 listener 尚未创建、HTTP 尚未赋值或多个 close 同时失败时，仍独立尝试 WebAuthn revoke、全部审批 server、HTTP、RPC destroy、Approval Authority 与 Lease Authority，并用 `AggregateError` 保留全部失败；startup 原错误仍为父层主错误。
4. **I3 移除生产注入**：Authority execution Host 的公开 options、父进程序列化和 child 注册路径均不再包含 test-only approval context 注入。事务回归测试还证明注册回调失败会回滚 receipt 与 Grant，重启后同一 session 仍可成功消费且之后只消费一次。

五次外审门禁：

```text
npm run typecheck                              PASS
npm run lint:architecture                      PASS
npm run build                                  PASS
npm test                                       112 files / 830 passed / 14 skipped / 0 failed
npm pack --dry-run --workspace @mutil-skills/e2e-runtime
                                                PASS / 92 files / 83.3 kB
git diff --check                               PASS
```

本轮 `npm run e2e:golden` 的沙箱执行共 24 个失败，全部在产品断言前因宿主禁止 loopback `listen`（`EPERM`）或 Chromium MachPort/进程权限（`EPERM`）退出；没有观察到代码断言失败。按任务要求申请的沙箱外 Golden 被安全策略拒绝，因此本轮不能宣称新 production chain 已在该宿主完成 Golden 通过。真实 child 集成测试在相同沙箱中也按既有环境分支 skip；其 production chain 断言仍保留在测试和 Golden 中，等待可监听 loopback、可启动 Chromium 的批准环境复跑。

## 六次外审修复附录

本轮关闭跨 Host 激活、最终化持久幂等、ephemeral 注册顺序、严格 IPC 和直接 CLI reservation 五类问题，并明确覆盖五次外审中“注册失败回滚 Grant”的旧结论：

1. **持久 finalization outbox**：Authority snapshot 提升到 `2.3.0`。receipt take、SignedGrant 与 finalization identity/binding/outbox 在同一 SQLite transaction 内提交；相同请求并发或重试返回同一 Grant，不同 request digest/subject/binding 失败关闭。`2.2.0` 原样保留既有授权并迁移空 outbox；`2.0.0/2.1.0` 继续按旧签名域验证并撤销旧授权。
2. **跨 Host 激活**：删除 Local Authority 的 RPC 注册 callback。child 在 Authority commit 后才更新 ephemeral client registration，并用同一控制 mutex 串行 finalize/recover/activate。注册失败不补偿持久 outbox；新 Host 可恢复或激活同一 Grant。激活要求完整严格 SignedGrant、当前状态库逐字段一致、签名有效、未撤销、未过期且 Run/install/type/subject digest binding 精确匹配。
3. **Runtime/CLI 恢复**：machine requestId 与直接 CLI 的内容寻址 identity 都在 WebAuthn 前写入 global reservation。Authority 已 commit 而 Run Store outcome 失败时保持 pending；重试先 recover，不创建新 session、不重复展示 URL。恢复后在 Run lock 内重读并复验项目身份、Run、安装、审批类型与 subject；发生变化不写 outcome。成功记录后，已完成 requestId 进入下一次 CLI identity 的输入，允许新的人工审批。
4. **严格 IPC 与 cleanup**：HostConfig、full SignedGrant、ready/control/session/shutdown result 均拒绝额外或缺失字段。state/session key 的解析临时 Buffer 在成功和失败路径均 `finally` 清零，重复 roots 不再静默去重。显式 shutdown 返回严格 cleanup 状态；startup/SIGTERM cleanup 有界发送稳定 `E2E_*` cause，父端聚合错误、仍执行 shutdown→TERM→KILL，并避免 child 已完成 cleanup 后二次 shutdown 的 EPIPE 覆盖原始 startup cause。
5. **Host2 Golden**：可逆写 Golden 现在由 Host1 完成真实 WebAuthn、finalize 和持久化后关闭；全新 Host2 使用新 session key 激活持久 Grant，随后新建 RPC client 执行 verify/reserve。真实 child 集成测试同样覆盖错误 Run、畸形 Grant 与 Host2 激活。

六次外审门禁结果：

```text
npm run typecheck                              PASS
npm run lint:architecture                      PASS
npm run build                                  PASS
npm test                                       114 files / 841 passed / 14 skipped / 0 failed
npm pack --dry-run --workspace @mutil-skills/e2e-runtime
                                                PASS / 92 files / 86.1 kB
git diff --check                               PASS
```

14 个常规测试 skip 均为当前 sandbox 禁止 loopback/真实 child/受控浏览器的既有显式分支。`npm run e2e:golden` 在同一 sandbox 的 24 项全部于产品断言前被环境阻断：21 项为 `listen EPERM`，3 项为 Chromium MachPort/进程权限拒绝；未观察到代码断言失败。本轮按要求未申请沙箱外 Golden，也不把这些环境失败记为产品通过。

## 七次外审修复附录

本轮关闭 commit 后注册失败、终止清理、严格生产边界、secret 临时副本和 outbox 生命周期五类问题：

1. **commit-after-registration recovery**：child 在 Authority 已提交、ephemeral RPC registration 失败时返回专用 `E2E_APPROVAL_FINALIZATION_RECOVERY_REQUIRED`。machine global reservation 与直接 CLI stable reservation 都保持 pending；fake child→process handle→Runtime 集成测试证明第二次请求 recover 同一 Grant，WebAuthn session/finalize 各只发生一次。recover/注册/outcome 在同一 Run lock 中完成，竞争 writer 得到稳定 locked 错误。
2. **finalization ack 与资源上限**：Run outcome 成功后使用 finalization identity、request digest、grantId 和四字段 binding best-effort ack；ack 失败不覆盖已持久化成功。Authority 对现存 outbox 精确匹配、重复 ack 幂等；按 Grant expiry 裁剪，容量固定 1024，超限签发整事务回滚，1025 项 snapshot 拒绝加载。lost ack 过期后，新 user-presence session 可签发新 Grant。
3. **严格 IPC、Grant 与 binding**：child 全部 incoming envelope 和 nested control payload exact；错误码只透传严格 `^E2E_[A-Z0-9_]+$`，已知平台权限错误映射为稳定 E2E code。SignedGrant 与 subject 对 origin/path/query/body/header/date、所有计数以及 injection/WS/SSE 上界实施生产限制，注入正文 digest 必须复算。四字段 binding 使用唯一内部 parser；parser 只做结构验证，不登记 trusted client。
4. **生命周期与密钥清零**：parent 严格解析 `terminal-cleanup-error` 并保留 child Aggregate cause；disconnect 等待 exit，非零 exit 映射稳定 cleanup failure，close 同时保留 cleanup 与 stop failure。session/control waiter 共享 terminal signal。parent 校验 state key 不再制造临时副本，序列化所需副本在 base64 生成后立即清零且不修改调用方 memory。
5. **串行控制回归**：finalize/recover/activate/ack 使用不被失败 poison 的单一 control queue。可跑 queue 单测和真实 child 测试共同覆盖“第一个注册成功、并发第二个 binding 失败、正确 retry 继续成功”；Host1→Host2 持久 Grant 激活 Golden 仍保留。

七次外审最终门禁：

```text
npm run typecheck                              PASS
npm run lint:architecture                      PASS
npm run build                                  PASS
npm test                                       116 files / 851 passed / 14 skipped / 0 failed
npm pack --dry-run --workspace @mutil-skills/e2e-runtime
                                                PASS / 92 files / 87.3 kB
git diff --check                               PASS
```

`npm run e2e:golden` 未申请 elevated：24 项均在产品断言前被当前 sandbox 阻断，其中 21 项为 loopback `listen EPERM`，3 项为 Chromium MachPort/进程权限拒绝。该结果只记录环境阻塞，不宣称 Golden 产品通过，也没有观察到进入产品断言后的失败。

## 八次外审修复附录

本轮关闭 ACK tombstone、child secret、启动状态机、Write intent 契约、真实 Runtime 恢复边界及三项结构收口：

1. **Authority `2.4.0` tombstone**：ack 将 outbox 原子移动到持久 `{ requestDigest, grantId, approvalBinding, expiresAt }` tombstone。精确重复 ack 幂等；request/grant/binding 任一 mismatch 拒绝。outbox+tombstone 合计上限 1024，两个集合共同 expiry prune、共同 oversized snapshot 校验；`2.3.0` 保留 outbox并迁移空 tombstone。
2. **child key 与启动期终态**：session key decode 后以 `try/finally` 包围 `registerClient`，抛错路径可观察地清零。启动期 disconnect 不再覆盖随后到达的 strict startup-error/exit；非零 exit 为稳定 cleanup failure，零 exit 为 startup exited，仅 disconnect 才等待 timeout。child 启动 cleanup 失败设置非零 exitCode。
3. **唯一 Write intent**：导出并复用 `WriteHttpIntentSchema`，subject 与 SignedGrant capability 对 method 的接受集合一致：1/32 大写 HTTP token 边界接受，lowercase/33 拒绝；Injection 继续使用独立 3–16 schema。真实 `issueWriteGrant → SignedGrantSchema` 边界往返通过，生成 schema set 更新为 `sha256:5a259753c2a83c4e12d92d54099ade25f681e1a8a5aefc817009a839da92ce0f`，历史内容寻址 schema sets 保留。
4. **真实 Runtime 恢复链**：新增未 mock `child_process` 的 `E2ERuntimeHost → RuntimeAuthorityHost → Authority child` 集成测试。测试用真实 P-256 WebAuthn assertion 让 child 提交 Grant，再模拟 Run Store outcome failure，关闭 Host1，以新 session key 启动 Host2 recover/activate；同一 request 只展示/完成一次 WebAuthn，随后由 Host2 authenticated RPC verify/reserve。当前 sandbox 禁止 loopback，因此该测试按稳定平台权限分支明确 skip；未申请 elevated，也不把 skip 记为通过。既有 Golden 的 Host1-close→Host2 chain 保持不变。
5. **结构收口**：四字段值改名 `ApprovalExecutionBinding`/`parseApprovalExecutionBinding`，唯一 parser 自己拥有 exact-key 校验，Trusted 仅保留给 WeakMap 客户端登记。parent finalized result 删除重复四字段手工解析。machine 与直接 CLI 共用 `persistFinalizedApprovalOutcome`，保证 outcome 先持久化、成功后 best-effort ack、持久化失败保持 pending。

八次外审门禁：

```text
npm run typecheck                              PASS
npm run lint:architecture                      PASS
npm run build                                  PASS
npm test                                       119 files / 861 passed / 15 sandbox skips / 0 failed
npm pack --dry-run --workspace @mutil-skills/e2e-runtime
                                                PASS / 96 files / 87.8 kB
git diff --check                               PASS
```

`npm run e2e:golden` 按要求未申请 elevated：24 项仍全部在产品断言前被宿主环境阻断，其中 21 项为 loopback `listen EPERM`，3 项为 Chromium MachPort/进程权限。未观察到产品断言失败，且不宣称 Golden 在该宿主通过。
