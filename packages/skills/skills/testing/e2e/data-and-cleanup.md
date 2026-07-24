# 数据租约与清理闭环

## 适用状态

纯只读为 `binding-draft → awaiting-execution-approval`；包含写 data need 为 `binding-draft → lease-reserved → awaiting-execution-approval`。Runtime 在冻结 Execution Contract 时按真实 `resourceKey + resourceFingerprint` 原子取得并激活整批 DataLease；Grant 最终化只校验已预留 Lease。执行后到 `finalizing` 前必须完成 cleanup 审计。

## 必需 Artifact 与摘要

`execution-contract`、Action Map digest、runId、resource fingerprint、测试数据策略和 cleanup plan。

## 允许的语义输出

租约需求、资源冲突说明、清理观察候选；标准输出为 `data-leases` 与 `cleanup-results`。

## 调用的确定性 API

Skill 唯一调用固定 launcher `~/.mutil-skills/bin/repo-e2e rpc`，按 JSON stdin/stdout 发送严格 `RuntimeRequestEnvelope` 并解析严格 `RuntimeResponseEnvelope`。每个业务命令成功后必须立即调用 `get-status`；只有严格拒绝未知字段的 `get-status` `result` 才提供 `state`、`nextEdge`、`verifiedDigests`、`minimumMissingInput`，其他命令结果不得用于猜测状态；Lease、Gateway 和 cleanup 分类均为 Runtime 内部责任。当 `submit-candidate` 返回 `reservedLeases` 时，Skill 必须把其 `leaseId/resourceKey/resourceFingerprint/fencingToken` 原样纳入审批主题，不得自行生成或猜测 token。

Runtime 内部必须使用 `LocalLeaseAuthority.open({ statePath, testWorkspaceRoots })` 在全部测试工作区之外打开持久 Lease Authority，调用批量预留、校验、release 与 quarantine；调用 Gateway 校验最新 fencing token，并由 Engine 分类 cleanup 状态。

## 执行步骤

按 resourceKey 申请 exclusive/shared lease；`resourceKey` 和 `resourceFingerprint` 必须来自 Execution Contract 并进入 WriteApprovalSubject 签名，不得由 runId/actionId 临时合成。所有写 Lease 必须先完整预校验，再在单一 Authority 事务中整批激活；任一资源争用时不得留下部分 active Lease。写前通过固定公钥摘要的 `lease.verifyTarget.v1` 认证 RPC 动态复验 leaseId、fencingToken 和每个 HTTP request 的 targetFingerprint，生产模式不得退回内进程 Lease 对象。Grant 签发前任一 Lease 不存在、已过期、被隔离或 fencing 不一致都失败关闭；签发过程异常时保留占用供同一 finalizationId 恢复，绝不能把未知写状态自动当作可释放。

把 cleanup plan 规范化为不可变定义，至少绑定 cleanupPlanId、actionId、leaseId、executorId、批准的 cleanup request intent 集、验证探针和 timeout；使用 `cleanup-plan-definition/v1` 从完整 preimage 重算 digest。受控 Runtime 只能执行 Registry 中已注册且 ID/digest/action/lease 全部一致的 executor，同一 ID 不得替换定义或执行器。执行后重新读取状态，并把完整 plan 定义、结果摘要和 lease receipt 摘要写入 `cleanup-results`，供 staging 再次重算。Lease、resource owner 与 fencing counter 必须在同一 SQLite 事务中持久化；多实例争用同一 resourceKey 时只能有一个成功，释放再申请后的 fencing token 必须在重启后单调递增。过期 tentative lease 可回收；过期 active lease 必须隔离，未经 verified cleanup 不得释放。DataLease 生命周期与清理证明分开记录；`cleanup-results` v2 只能使用 `not-needed`、`verified-clean`、`failed`、`unknown`。

## 退出条件

执行前所需 lease 均 active；每个已执行写 action 都闭合到 Case data need、Execution data need、DataLease、cleanupRef 和 cleanup result；只有 `not-needed` 或 `verified-clean` 可满足清理门。

## 暂停条件

资源冲突、fingerprint 变化、lease 过期、cleanup 失败或 effect unknown。

## 禁止行为

不得用 lease 的 `released` 生命周期冒充 `verified-clean`，不得用描述性 ID 冒充 lease 或 cleanup plan，不得让任意 callback 绕过不可变 Registry，不得绕过 fencing，不得接受结构相同但未由 Authority 创建的伪 Lease client，不得把 Lease SQLite 放入测试工作区，不得在正式执行中使用仅内存 Lease Authority，不得自动重试可能已生效的写，也不得把 `failed`/`unknown` 报成完成。旧 released 记录缺少独立验证证明时必须 `migration-required`。

## 独立调用

缺少必需 artifact/digest 时，只返回最小缺失项；不得重建上游，不得推进状态。
