# E2E Runtime 签名更新运维说明

## 用户可用策略

- `offline`：使用本机 `current` 的完整已验证 closure，不联网；报告为 `offline-unchecked`。
- `pinned`：使用本机精确版本及可选 installation digest，不联网；报告为 `offline-unchecked`。
- `stable`：仅在发布组织配置经审核 TUF root、HTTPS metadata origin、doctor 与隔离 canary 后可用；成功报告为 `revocation-checked`。
- `latest`：尚未批准，始终拒绝。

`stable` 失败不会静默退化为 `offline`。用户必须明确选择离线策略，报告也不会把“未取得最新撤销信息”显示成安全通过。

## stable 固定流程

1. 从 npm package 内的已审核 `root.json` 引导 TUF，不从网络首次信任密钥。
2. 官方 `tuf-js` 顺序验证 root、timestamp、snapshot、targets。
3. Runtime 再验证 target 的 channel、版本、Node、平台、协议、bootstrap、撤销状态与 registry origin；签名 registry URL 必须与实际 TUF target URL 完全一致。
4. 下载层限制 HTTPS origin、三次重定向、30 秒超时、角色/target 最大长度；TUF 验证 target 长度和 SHA-512，且 SHA-512 必须与 npm integrity 表示同一份 tarball。
5. 下载文件被复验为当前用户独占的私有 `0600` 普通文件；安装器在同一文件描述符上再次校验精确长度、SHA-512 与读取期间不变性，然后使用 bootstrap 显式固定的 npm CLI 绝对路径，以禁用 scripts、清洗环境的方式安装候选 closure，不依赖 `npm exec` 是否遗留环境变量。
6. installer 复验 package identity、全部内部 E2E 包版本、installation/content/executable digest 与 npm integrity，只发布候选，不移动旧 `current`。
7. 执行 candidate doctor 和无业务数据的隔离 canary。
8. 全绿后写 `new-run-default`，旧默认成为 LKG；Resolver 在安装锁内复验并给新 Run 固化 installation digest。

已通过 TUF 验签的 metadata 角色高水位会在解释 target 前持久化。因此，即使最新 target 被撤销或业务身份无效，客户端也不会在下一次更新中重新接受更旧的 metadata。

更新锁记录当前用户、PID 与随机 nonce，并在释放/恢复时复验 inode。并发活进程和 PID 复用一律阻断；只有能由 OS 明确证明 PID 已死亡的私有遗留锁才会自动回收，从而兼顾崩溃后幂等恢复与锁劫持防护。

## 发布组织必须自行提供

- 3 把 root、3 把 targets 离线私钥及 2-of-3 签名流程；私钥不得进入仓库、npm 包、CI artifact 或 Runtime HOME。
- 审核后的 bootstrap `root.json`、metadata HTTPS origin、签发轮换与紧急撤销值班责任。
- Linux/macOS、Node 22/24 clean-HOME Registry Golden。

仓库当前没有这些真实运营材料，因此实现默认 fail-closed。用测试私钥或临时 URL 让 CI“变绿”不构成生产验收。

## 生产激活审计命令

`npm run verify:e2e-stable-activation` 是唯一的生产 stable 激活汇总入口。它先让官方 `tuf-js` 从内置 root 对真实 HTTPS origin 执行 refresh，再校验 Runtime target 身份、metadata 最大剩余寿命、2-of-3 治理事实和以下六份不可替代的门禁证明：

1. 500/2000/5000/1000 生产模块 p95 proof；
2. 稳定系统 Chrome 的加权 B 端覆盖 proof；
3. Runtime 模块冷启动、TUF 更新冷/热缓存、32 路真实 Resolver、诊断和 Artifact retention 生命周期非功能 proof；
4. Linux/macOS、Node 22/24 clean-HOME Registry Golden proof；
5. 使用生产签名 staging metadata 完成的紧急撤销 drill proof；
6. 使用同一 staging 环境完成的 LKG recovery drill proof。

命令要求显式提供 `E2E_STABLE_AUDIT_HOME`、`E2E_STABLE_TRUSTED_ROOT`、metadata/target URL 与 path、registry allowlist origin、六份证据 envelope 路径及输出路径。每个 envelope 必须包含原始 `artifact`、绑定 Runtime/installation/commit/environment 的 payload，以及 target `activationPolicy` 登记证据密钥达到阈值的 Ed25519 签名。审计器不仅重算 envelope 中的原始 artifact digest，还按 proof 类型执行严格 schema、语义不变量、完整阶段集合和内部 proof digest 复算；签名正确但内容无意义的 artifact 仍会 fail-closed。

`npm run verify:e2e-tuf-preflight` 用于发布前检查候选 metadata origin：官方 `tuf-js` 完成阈值验签和角色链更新，Runtime 再检查历史高水位、四角色寿命上限、2-of-3 root/targets 治理、target 身份和 registry allowlist。它不写生产 update state，也不生成或接触私钥。

`npm run verify:e2e-stable-update-drill` 生成撤销或 LKG 恢复演练 artifact。`revocation` 模式比较演练前后状态并要求 metadata 前进、tombstone 命中以及新旧 Run 同时阻断；`lkg-recovery` 模式调用显式 `restoreRuntimeLkg`，原子保存后复读，要求 metadata 高水位不变、LKG 成为新 Run default 且已有 Run installation digest 不变。

`npm run verify:e2e-registry-golden-proof` 汇总发布后四格 Registry Golden：macOS/arm64 与 Linux/x64 分别在 Node 22、24 上都必须 `ok=true`、`mode=registry`、`skippedTests=0`、`packageSource=npm-registry`。命令绑定 14 个包、Runtime version、installation digest 和 source commit，workspace tarball 结果不能代替 Registry proof。

本命令不会生成私钥、不会替发布组织声明演练成功，也不会自行实现 TUF 签名验证。最终输出 `ready=true` 仍只是“允许启用 stable feature flag”的审计凭证，不替代持续监控、轮换和值班责任。

## 撤销与 LKG 演练步骤

1. 在与生产相同密钥治理的隔离 staging origin 发布一个可安装 target，完成 Registry Golden、doctor、canary 并成为 new-run-default。
2. 创建一个绑定该 installation digest 的 Run，保存恢复句柄。
3. 以 targets 2-of-3 流程发布更高版本 metadata，将该精确 target 标记 revoked 并给出原因码。
4. 新 Run 解析必须拒绝该 target；第 2 步旧 Run 在恢复边界必须得到 `E2E_RUNTIME_RUN_INSTALLATION_REVOKED`，保持原绑定且进入 safety-blocked。
5. 发布一个故意 canary 失败的更高版本 target，验证 default 不变化、旧 default/LKG 不被污染。
6. 关闭 stable refresh 并显式恢复既有 LKG 为 new-run-default；验证已有 Run 摘要未变化、metadata 高水位未删除。
7. 两项演练分别生成带 environmentId、metadata versions/digests、target installation digest、前后 default/LKG 和审计摘要的签名 proof。proof 不得包含私钥、token、HOME、PRD、目标业务 URL 或响应正文。
