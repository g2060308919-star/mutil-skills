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
