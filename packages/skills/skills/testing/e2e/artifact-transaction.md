# 同代 Artifact 事务与恢复

## 适用状态

`publication-ready → [atomic commit] → 终态`；恢复 `finalizing | publication-ready → artifact-blocked | migration-required`。

## 必需 Artifact 与摘要

完整的当前 staging generation、正式 `generation-manifest.json`、FinalizationSnapshot、Authority signatures、`workflow-events v2`、Attempt Authority 公开验签材料和 assetId。

## 允许的语义输出

事务/恢复 finding 与阻塞建议；active、journal、fencing token 和发布终态只采用 Artifact Store/Engine 返回值。

## 调用的确定性 API

Skill 唯一调用固定 launcher `~/.mutil-skills/bin/repo-e2e rpc`，按 JSON stdin/stdout 发送严格 `RuntimeRequestEnvelope` 并解析严格 `RuntimeResponseEnvelope`。每个业务命令成功后必须立即调用 `get-status`；只有严格拒绝未知字段的 `get-status` `result` 才提供 `state`、`nextEdge`、`verifiedDigests`、`minimumMissingInput`，其他命令结果不得用于猜测状态；下列机制均为 Runtime 内部责任，不是 Skill 可直接导入的低层接口。中断事务恢复必须发送真实的 `"command":"resume-run"`，不得以重新提交或文本建议冒充恢复。

Runtime 内部必须调用完整 publication auditor、Artifact Store commit/recover/gc、Authority/Attempt Authority 验签、Contracts migration 和 Engine publication transition。正式运行的 Approval Authority 与 Lease Authority 必须从各自受保护的 SQLite 持久状态打开，而不是在进程内重新生成状态。

## 执行步骤

验证 macOS/Linux POSIX 本地文件系统与 Python 3.9+ helper；拒绝位于任何 `testWorkspaceRoots` 内的 Authority/Lease SQLite。验证持久状态的文件权限、issuer/keyId/可信身份摘要；Approval Authority 的 32-byte `stateEncryptionKey` 必须来自 Git 外 Secret Provider，数据库中的签名私钥必须为带随机 IV、认证标签和按 key 分类 AAD 的 AES-256-GCM 密文。确认 grant、撤销、nonce 使用计数、完整上下文 reservation、Attempt append-only 日志、Lease owner 与 fencing token 可跨重启恢复，错误密钥必须 fail closed。Authority snapshot 必须与 `TrustedMonotonicAuthorityStateAnchor` 精确闭合；要声明抵抗同一 UID 的整体状态回滚，生产部署必须注入权限和介质均独立于 SQLite、状态密钥与 Runtime 的 `trusted-monotonic` provider，并由 provider 线性化 `compareAndAdvance`。默认本地 anchor 只有恒定空间的 crash/integrity 能力：anchor 缺失、跳号或 DB/anchor 不一致一律失败关闭，但同一 UID 同时回滚 DB、密钥和 anchor 明确不在其威胁模型内。reservation/终态幂等记录必须有持久硬上限，容量耗尽时停止签发，不能淘汰旧记录改变重放语义。取得 advisory lock/fencing；publication auditor 必须重读当前 staging 的全部候选 bytes，重新解析 27 Artifact、secret 和文件闭包，并使用独立 verifier 重算 `workflow-events v2` 初始链、事件链、selection、workflowDigest 及其与 `browser-results v2`/FinalReport 的精确投影，不得复用首次构建 closure。审计通过后写不可变 generation；按双槽/journal 协议切 active；重读验签引用后 GC；释放锁。

## 退出条件

active 指向唯一完整同代 generation，正式 manifest 与 `.publication-integrity.json` 双层闭合；当前 staging 的 Attempt 链、结果、报告三者独立复算一致；journal committed，旧代安全清理，终态与 snapshot verdict 一致。

## 暂停条件

NFS/SMB/Windows、锁冲突、Schema/secret/签名/路径失败、无可靠 generation、磁盘/权限/fsync 错误或 migration 不可无损。

## 禁止行为

不得直接覆盖 active、超时接管锁、跟随符号/硬链接、在锁外 GC、发布 artifact-blocked generation、接受调用方 `verifyAttemptSelection` closure、删除 SQLite 持久状态以绕过撤销/防重放/fencing，或用文档步骤替代 Store。

## 独立调用

缺少必需 artifact/digest 时，只返回最小缺失项；不得重建上游，不得推进状态。
