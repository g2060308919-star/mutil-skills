# Task 8 实施报告：固定 Chromium、Browser Host 与只读纵向闭环

## 结果

Task 8 已完成代码实现：固定 Browser 安装/inspect、持久 Browser Host、Gateway 强制代理与 canary、内部 discovery preflight、冻结资产投影、authenticated Authority discovery/read RPC、RuntimeHost fenced execute、证据闭合、Doctor capability proof 以及自包含真实 Golden driver。真实 Golden 需要已执行 `repo-e2e install-browser` 的 HOME；当前 sandbox 未提供该 HOME，因此明确 skip，未计为产品通过。

## 核心边界

- RunStore `1.1.0` 保存严格冻结 Artifact 与内部可信事实；外部 `submit-candidate` 不能写 preflight、Grant、审计或证据。
- TrustedFact capability 由私有 WeakMap 鉴真，并绑定 Store、Run、lock、runRevision、snapshot digest，单次消费。
- `run-preflight` 从 persisted SignedDiscoveryGrant 出发，真实走 Authority RPC、Gateway、Browser 与 `runBrowserPreflight()`；ready fact 闭合 Run、Grant、reservation、观察身份、Browser/Gateway/canary/Authority provenance，并与 workflow 在同一事务写入。
- 公共 Host 已有从 `create-run` 出发的完整可达链：语义 Candidate、scope 用户在场、正式 Discovery Grant、preflight、三类 binding 资产、正式 Execution Grant、regression manifest、compiled、execute；集成测试使用真实 `LocalApprovalAuthority` 签发并验签，不 seed RunStore 状态。
- `execute-run` 在执行前验证 frozen facts，原子持久化 `compiled→running-real` 与 attempt/fencing/revision，释放锁后执行，再重锁核对并进入 diagnosing 或明确阻塞态。崩溃 attempt 仅允许通过 `resume-run` 提交 `reconcile-stale-read` 与完全匹配的 attempt ID 显式关闭：不调用浏览器、不自动重试，同一事务清除 attempt、进入 safety-blocked、保存 attempt 审计详情并关闭原 pending global/local outcome。
- 长执行使用独立 execution-owner lease、heartbeat 和 fencing；mutation lease 释放后 owner 仍存活，第二个 Host 不能把正在运行的 Browser attempt 误判为陈旧。attempt 已提交但 mutation lease 释放失败时不启动 Browser，原请求保持 pending，可显式恢复。
- Preflight 使用 Browser prepare→RunStore preparation→Authority finalize→fact/replay 原子提交。Discovery reservation 只对完全相同的稳定 attempt（绑定 Run/request/request digest）精确幂等；reserve 后尚未来得及落盘 preparation 时，重建 Host 可复用同 reservation，不增加 capability use。Authority finalize 已完成但 fact 落盘失败时，从持久 preparation 恢复，不重复 Browser 或 reservation。
- Read executor 是私有 branded capability；它自己从 snapshot 投影唯一 Action，严格交叉校验 case/action/status、evidence bytes/digest 和 Gateway counters/signed audit digest，不接受 caller 结果冒充。
- 多能力只读执行在 reserve 半成功时完成补偿；complete 中途失败时把失败项及剩余项通过 authenticated `read.markUnknown.v1` 标成 unknown。失败结果保留全部 reservation IDs 与 outcome digest，不留下无恢复线索的悬挂能力。
- Browser 固定 persistent context、最小 env、Gateway proxy/SPKI、禁 QUIC/extension/background/non-proxied WebRTC；CDP 实际 command line 与真实页面 canary 共同形成 measurement。
- Browser/Gateway/Authority client 全部独立清理并聚合错误；主错误与 cleanup 错误同时保留，stdout 只在清理完成后写一次。
- Doctor 从不安装或启动 Browser/Gateway，只读验证成功会话写入的 installation-bound capability proof；无 proof 为 not-installed，篡改/权限/binding 错误为 blocked。
- Fresh install 不依赖业务 Run 生成首份 proof：`repo-e2e install-browser` 安装后显式执行空业务规则 Gateway + ControlledBrowserHost canary bootstrap，完成 finalize 与全部清理后才原子写 proof；任一步失败命令失败且不写 proof。
- Authority RPC connection 的临时 session-key 字符串在 client 构造成功/异常后都立即从 connection clone 清除，client `destroy()` 再清零内部解码 Buffer。

## 验证证据

```text
npm run typecheck
PASS

npx vitest run packages/e2e-runtime/test/runtime-capability-proof.test.ts \
  packages/e2e-runtime/test/runtime-doctor.test.ts \
  packages/e2e-runtime/test/runtime-browser-wiring.test.ts
Test Files  3 passed
Tests       15 passed

npx vitest run packages/e2e-runtime/test/runtime-host.test.ts \
  packages/e2e-runtime/test/run-store.test.ts \
  packages/e2e-runtime/test/trusted-action-runner.test.ts
PASS

Task 8 focused（Authority RPC/Discovery、安装器、Browser Host、生产 wiring、proof、
Trusted Runner、只读闭环、Doctor、RuntimeHost、RunStore、迁移、Playwright runner、
Golden installation/proof）
Test Files  14 passed
Tests       135 passed

npm test
Test Files  134 passed / 1 skipped / 1 failed
Tests       1032 passed / 24 skipped / 2 failed
两个失败均为并行全量运行时 artifact-recovery-matrix 的既有 5 秒超时；独立复跑：
Test Files  1 passed
Tests       21 passed

npx vitest run --config vitest.e2e.config.ts scripts/e2e-runtime-read-only.golden.test.ts
Test Files  1 skipped
Tests       1 skipped
原因：未提供 E2E_RUNTIME_REAL_GOLDEN_HOME；不计为通过。

git diff --check
PASS
```

## 真实 Golden 运行方式

```text
E2E_RUNTIME_REAL_GOLDEN_HOME="$HOME" \
  npx vitest run --config vitest.e2e.config.ts scripts/e2e-runtime-read-only.golden.test.ts
```

Golden 自己创建临时 HOME、项目声明、PRD/policy、HTTP 页面、持久 `LocalApprovalAuthority` 和 authenticated Authority RPC Server。它先验证外部 Runtime/browser closure，复制到临时 HOME、重绑并再次验证 installation，然后从复制后的已安装 Runtime 动态加载 `dist/src/cli.js`。全部 machine 命令都经 `runCli(['rpc'])`，从公共 `create-run` 开始逐项提交候选、审批、真实 preflight、compile 与 execute；不直接调用 RunStore/RuntimeHost，不预置 Run、trusted facts 或 compiled 状态，也不注入 preflight/read executor。外部 HOME 只提供当前 Runtime installation 与其绑定的固定 Browser closure。

Golden 还先验证源 HOME 的 installation-bound capability proof，仅把验证后的 gateway/isolation proof 重建到临时 HOME 并再次复验；缺失、损坏或错绑定都在启动前阻塞。Doctor 由复制后的已安装 Runtime 动态加载，Task 8 门禁真实要求 gateway/chromium/isolation 三个 probe 通过，不再注入恒为 ready 的假报告。

## Residual

- 当前没有真实 Golden 的执行通过证据；在允许 loopback/child/Chromium sandbox 且已安装 Browser 的环境中运行上述门禁后才能把该项标记为通过。
- 全量并行测试中的 `artifact-recovery-matrix` 有一个既有 5 秒阈值超时；同文件独立复跑 21/21 通过。该现象不属于 Task 8 代码路径，但最终发行门禁仍需消除并行超时或调整为经测量的合理阈值，不能把 focused PASS 替代最终全绿。
- Capability proof 是当前用户状态中的完整性/installation 绑定普通 hash 证明，不是 Authority attestation，也不是硬件单调锚。Task 10/12 必须把它纳入签名 provenance；能够连同整个用户状态一致回滚的攻击者仍需要外部可信单调计数器才能检测。
- Task 8 tracer bullet 只承诺旧版单文档请求。SPA 子资源/API 的显式 allowlist 需要同时升级 execution-contract、action-map、Read/Discovery approval subject 与“一请求一 capability/rule”，与 Task 9 多请求写路径重叠，已作为 Task 9 第 0 切片，不以 optional 放行绕过。
- Read RPC reservation context 当前仍需在 Task 9 绑定 clientId 并做终态有界清理；Browser/Installer/Proof 的若干同 UID 路径校验后使用窗口需在 Task 10/12 统一收敛到 dirfd/openat。二者均为已记录 P2，不作为放宽当前 fail-closed 规则的理由。
