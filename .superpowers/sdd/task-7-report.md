# Task 7 实施报告：独立 Gateway Proxy Host

## 结果

Task 7 已实现 Runtime 内独立 HTTP/HTTPS forward proxy Host、WebSocket 安全拒绝边界、严格规则投影、认证有序 IPC、Authority-backed policy seam、CA 安全存储、默认拒绝与 signed Gateway audit。生产 package 根入口未暴露 action token、任意代理请求方法或测试控制口；Browser Host 只取得 opaque correlation binding、Gateway measurement 与专用 canary proof seam。

## 最终架构

- Mockttp `4.4.2`（Apache-2.0）只负责 HTTP(S) 传输/TLS；allow/inject/write 决策分别由 `ReadOnlyGateway`、`InjectionGateway` 和 `ReversibleWriteGateway` 执行。
- `gateway-rule-projector.ts` 把已批准请求严格投影为 method、canonical full URL、action/capability、必要 body、channel、`maxUses` 与行为；每条规则使用 256-bit 随机 opaque token，policy digest 明确排除 token。
- Gateway 在独立 Node 子进程运行，仅监听 `127.0.0.1`。父子 IPC envelope 精确绑定 schema、direction、requestId、单调 sequence、operation 和 HMAC-SHA256；错误 MAC、乱序和重放 fail closed。
- HTTP correlation headers 在转发前删除。Mockttp 的 WebSocket 消息事件是转发后的观察事件，不能证明逐帧 policy；因此正确 token/capability 也固定返回 501 `E2E_GATEWAY_WEBSOCKET_BRIDGE_UNAVAILABLE`，不连接上游且不 reserve，未知 WebSocket 仍返回 403。
- child 在首个 await 前同步 claim `remainingUses`，避免并发 matcher 同时穿透；真实写入测试要求两个并发请求只有一个 200、一个 403，且上游与 Authority reserve 都只发生一次。
- 写响应只形成 `transportObserved`，不会提前 Authority complete。Runtime 在 cleanup/effect observation 后通过 `GatewayWriteLifecycle.finalizeWriteOutcome()` 提交完整 signed outcome；abort、child disconnect、显式 unknown 或未最终化 close 会 mark unknown。
- 独立 write 状态协调器在首个 await 前原子 claim finalize/unknown；close、child exit 与调用方并发不能对同一 reservation 同时 complete/unknown。多步请求必须全部 transport observed 且 `ReversibleWriteGateway` sequence complete 后才开放 finalization，任一 outstanding abort 会 unknown 整个 reservation。
- `finalize()` 先冻结新接入、等待 child in-flight drain、terminal settlement 与未完成 write settlement，最后才关闭 audit recorder；child error/exit 会立即触发全部 active/reserved write unknown，原 promise 同时挂安全 rejection observer，finalize/close 仍必须等待并传播结果。
- 专用 canary 使用独立一次性规则、独立计数和独立 policy digest，不消耗业务规则。proof digest 绑定 Browser measurement、Gateway session measurement、canary policy 与精确计数 delta。
- CA generation 通过可信 Python 逐级 `openat`/`O_NOFOLLOW` 验证 current UID、authority root `0700`，以 staging+fsync+rename 原子创建 `gateway-ca`；key/cert 为 `0600`、regular file、nlink=1。父进程固定 generation dirfd，child 通过可信 wrapper `fchdir` 后只打开相对 `key.pem`/`cert.pem`。公开 handle 仅返回 cert 路径与 SPKI，不返回私钥。
- CA 复用时只验证私钥 inode/owner/mode/size，不读取私钥内容；初次生成时 JS key Buffer 与 Python `bytearray` 在使用后尽早清零。partial/symlink generation state 一律 fail closed。
- Gateway child config 和全部运行期 IPC payload 都做 exact/有界解析；CA helper stdout/stderr、超时、endpoint loopback、目录身份与进程清理均有稳定失败边界。

## TDD 与定向证据

```text
npx tsc -b packages/e2e-gateway packages/e2e-runtime --pretty false
PASS

npx vitest run packages/e2e-runtime/test/gateway-proxy-security.test.ts \
  -t 'Gateway IPC|规则投影|CA generation'
Test Files  1 passed
Tests       4 passed | 12 skipped by explicit test filter

npx vitest run packages/e2e-runtime/test/public-exports.test.ts
Test Files  1 passed
Tests       1 passed

npx vitest run packages/e2e-gateway/test \
  packages/e2e-runtime/test/gateway-state-machine.test.ts \
  packages/e2e-runtime/test/gateway-proxy-host.test.ts \
  packages/e2e-runtime/test/gateway-proxy-security.test.ts \
  packages/e2e-runtime/test/public-exports.test.ts
Test Files  8 passed | 1 skipped
Tests       65 passed | 9 skipped

npm run lint:architecture
PASS

npm run build --workspace @mutil-skills/e2e-runtime
PASS

npm pack --dry-run --workspace @mutil-skills/e2e-runtime
PASS / gateway-ca-openat.py 与全部 Gateway dist 文件已进入 tarball

git diff --check
PASS
```

这里的 `12 skipped` 只是早期 `-t` 定向过滤，不作为产品通过数。最终 focused 的 9 个 skip 全部是已注册但当前 sandbox 无法执行的真实 loopback transport；65 个实际通过测试包含完整 e2e-gateway package、Gateway IPC/projection/CA、write/finalize 状态机、四种 WebSocket behavior fail-closed disposition 与 public exports。

## 真实代理矩阵的环境阻塞

```text
npx vitest run \
  packages/e2e-runtime/test/gateway-proxy-host.test.ts \
  packages/e2e-runtime/test/gateway-proxy-security.test.ts

Test Files  1 passed | 1 skipped
Tests       9 passed | 9 skipped
```

9 个真实 transport 测试在 suite 注册时先执行 loopback capability probe；当前默认 sandbox 明确返回 `listen EPERM: operation not permitted 127.0.0.1`，因此整组以带原因的 `describe.skipIf` 跳过。分组前的诊断执行中，Gateway child 同样返回稳定码 `E2E_GATEWAY_LOOPBACK_UNAVAILABLE`，没有出现其他失败类别。纯单元矩阵新增 finalize/drain 顺序、finalize-vs-unknown、child-exit settlement、多步 request sequence、outstanding abort 与 WebSocket fail-closed disposition。测试 helper 会立即传播 listener error，避免用 timeout 掩盖环境原因。没有把这些 skip 记为产品通过；完整 HTTP/HTTPS/Beacon/Service Worker、并发写与 unknown transport 矩阵仍需在允许 loopback 的最终门禁中执行。

## 明确 residual 与后续边界

- Standards 两轮审查指出的高风险已修复：WebSocket 在无转发前 bridge 时不再 blind passthrough，且 pass-through/http-response/timeout/reset 四种 behavior 全部统一 501，不执行注入或 reserve；finalize 先 freeze/drain；write 终态由原子状态协调器 claim；child error/exit 立即触发 active/reserved write settlement。
- 最终双轴外审整改已纳入：injection session 零透传；签名 capability 与 projected response 在 reserve 前绑定；完成的 injection reservation 写入 signed audit；Browser 多步 correlation 绑定 rule/ordinal/body；response observed 后保留 request 映射直到显式终态；IPC result exact；请求 body 有硬上限且 chunked fail closed。继承 OS IPC 的 HMAC+sequence 等价边界已写入计划与设计 Errata。
- Task 7 提供生产 policy object 装配 seam，但 Injection/WebSocket/SSE 的 authenticated Authority RPC client 以及写 outcome 的 crash-after-complete 恢复协议由 Task 9 扩展；当前 test policy object 不能被描述为生产授权闭环。
- Task 8 必须用真实受控 Chromium 调用 `GatewayBrowserBinding` 完成 correlation 和 canary；Node test control 只验证 transport，不证明 Browser 被强制代理。
- WebSocket 命中规则仍不连接上游的断言、HTTPS MITM/SPKI、并发写 `maxUses=1` 和 abort/close unknown 测试已经编写，但当前工作树尚无允许 loopback 的执行证据。
