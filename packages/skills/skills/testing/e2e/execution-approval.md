# Discovery 与 Execution Approval

## 适用状态

`coverage-audited → discovery-approved`；`lease-reserved → awaiting-execution-approval → execution-approved`。

## 必需 Artifact 与摘要

`design-audit`、`test-cases`、`execution-contract`、v2 `browser-preflight`、v2 Action Map、v2 `run-bundle`、DataLease 引用和 project policy。执行前 subject 使用版本化 `approval projection` 摘要；投影覆盖安全与行为字段，只排除 Authority 随后生成的 capabilityId 及 Envelope/generation/fencing 字段。

## 允许的语义输出

Discovery/Execution ApprovalSubject 展示内容、待决定的 effect、环境/角色/数据缺失项。

## 调用的确定性 API

调用 Contracts 计算 `approval projection`；使用 `LocalApprovalAuthority.open({ statePath, stateEncryptionKey, testWorkspaceRoots })` 打开持久 Authority。`stateEncryptionKey` 必须由 Git 外 Secret Provider 提供且恰为 32 bytes，`statePath` 必须位于全部测试工作区之外。Authority 基于可信身份注册表和已认证会话签发短期 capability/grant 与专用 `freshness receipt`；调用 Engine `validateGeneration()`/`transition()`。freshness proof 使用独立签名 purpose/key，不能由通用 Artifact 签名代替。

## 执行步骤

先由受信认证边界把当前 OS/SSO 主体映射到 Authority 配置的 `approvalIdentities`；签发调用必须提交 `approvalSessionRef`，Authority 重新认证会话主体，并与声明的 subject 和登记 roles 精确匹配。再申请只读 DiscoveryCapability。冻结不含 capabilityId 的行为投影并签发 Grant；read 和 reversible-write 都必须使用 v2 subject，Run Bundle 投影必须覆盖输入引用、调度、尝试槽、secret、runtime policy、`runtimeIsolationPolicyDigest`，以及 capability 的 action/operation/effect/maxUses。可恢复写必须在服务端点和公钥确定后，把完整 `RuntimeIsolationPolicy` 写入 Execution Contract，再由 Run Bundle 固定其规范摘要；纯只读必须使用 `null/not-applicable`，不得夹带隐藏策略。把 Authority 返回的全部 capability 写入 Action Map 与 Run Bundle；最终化时让 receipt 同时绑定已批准投影和最终 Run Bundle 摘要。Builder 校验一次，Artifact Store staging 发布前动态复验一次当前 grant store、可信时钟、撤销状态、ready preflight、subject、最终 Run Bundle、隔离策略摘要与全部 capability。生产运行必须复用同一受保护的 `statePath` 和外部加密密钥；SQLite 中的五类私钥只保存 AES-256-GCM 密文，使 grant、撤销、nonce 使用计数、reservation 与 Attempt 日志在重启后仍可验证而私钥不以明文落盘。

Project Policy、Execution Contract、Browser Evidence 与 sanitizer record 必须使用同一 evidence policy；Project Policy、Run Bundle、Gateway signed audit 与 Browser Preflight gateway check 必须使用同一 runtime policy。已执行 Action 的每项 required capability 都必须在 Gateway 签名 reservation 中恰好出现一次、actionId 一致且 `consumed=true`。

## 退出条件

审批人角色、TTL、nonce、撤销状态和 subject projection 有效，Case 队列未变化；receipt 为 authentic/current/allowed，Engine 才进入 `execution-approved`。真实 expired/revoked/denied receipt 只能生成相应阻塞 verdict，不能 accepted。

## 暂停条件

任何决定 pending、capability 过期或撤销时停在 Engine 返回状态。`binding-draft`、`lease-reserved` 或 `compiled` 的审批主题变化回到 `awaiting-execution-approval`；已在 `execution-approved` 时必须先撤销旧 grant，再回到 `binding-draft`。

## 禁止行为

不得信任调用方自报 roles、subject 或未认证的会话引用，不得信任本地 JSON grant、用 Artifact Envelope 签名冒充 freshness proof、复用旧 receipt、只登记一个合成 capability、扩大 matcher、把不可逆 effect 降级，或在 Execution Approval 前执行 Case。不得把 Authority SQLite 或加密密钥放进测试工作区，不得把加密密钥与数据库一起持久化，不得在正式执行中用仅内存的 `LocalApprovalAuthority.create()` 代替持久 Authority；v1 扁平 approval metadata 或 v1 write subject 必须 `migration-required`。

## 独立调用

缺少必需 artifact/digest 时，只返回最小缺失项；不得重建上游，不得推进状态。
