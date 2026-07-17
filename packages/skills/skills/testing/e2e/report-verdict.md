# Verdict、Finalization 与报告

## 适用状态

`diagnosing → finalizing → publication-ready`。

## 必需 Artifact 与摘要

本代 27 类 Artifact 所需事实，尤其 scope、lineage、execution 三类审批、VerdictInput、`workflow-events v2`、`browser-results v2`、manual results、Gateway/evidence/cleanup audit、V2 regression manifest/Discovery attestation 和 Attempt Authority 独立验签材料。

## 允许的语义输出

报告标题、风险说明和展示排序候选。唯一结论、reason、Metric 和 cannotClaim 必须来自 Engine `FinalReport`。

## 调用的确定性 API

Skill 唯一调用固定 launcher `~/.mutil-skills/bin/repo-e2e rpc`，按 JSON stdin/stdout 发送严格 `RuntimeRequestEnvelope` 并解析严格 `RuntimeResponseEnvelope`。成功 `result` 必须拒绝未知字段并包含 `state`、`nextEdge`、`verifiedDigests`、`minimumMissingInput`。报告只能发送真实的 `"command":"render-report"`，Skill 不自行渲染 Markdown/HTML，也不得用 `get-status` 响应冒充报告产物。

Runtime 内部必须调用 Contracts 完整 generation 校验、Engine 持久化 Attempt 审计、`computeVerdict()`/FinalizationSnapshot、Report JSON→Markdown/HTML renderer 和 Engine `transition()`；Attempt Authority verifier 必须从公开验签材料恢复，不得捕获首次构建时的内存选择结果。

## 执行步骤

冻结 VerdictInput；让 Engine 从 `workflow-events v2` 重算每个 Case 的 selection，并与 `browser-results v2` 精确对齐；`CaseResult.status=passed` 只能由 Run Bundle 中全部 scheduled Step 精确覆盖、无重复、每个 Step `status=passed` 且每个 Oracle `passed` 推导，调用方不得自报通过。从落盘 Attempt 链投影每个 Case 的 `selectedAttemptId` 和 `diagnostics.attempts`。再从 Project Policy、Execution Contract 和 `executedBrowserIds` 三层事实复算浏览器限制。独立复验 regression manifest 与 Discovery attestation 的 `testDomain=prd-e2e-trusted-compiler`、`executionProfile` 和代际绑定，并把测试域与 Profile 写入 `final-report.regressionDetails`；报告审计必须对照 manifest 重算，调用方改写 Profile 时拒绝发布。再生成固定三项 approvals、dispositions、traceability 和 traceabilityMatrix；对每个 active automated obligation重建 `REQ→RULE→COV→CASE→STEP→EVIDENCE` 链路；`passed|failed` Step 必须关联真实证据，`skipped|unable` 只保留计划 edge 并投影 Case disposition，不合成证据；生成 final-report；渲染离线 MD/HTML；复验三者一致、相对链接、HTML escape、无 CDN；冻结全部文件摘要。

## 退出条件

唯一 verdict 可独立复算；approvals 必须且只能是 scope、lineage、execution，pending 决定的 grantDigests 必须为空；测试域与执行 Profile 在 attestation、manifest、final-report 三处一致；traceability、traceabilityMatrix、dispositions、selectedAttemptId、diagnostics.attempts 与浏览器 `cannotClaim` 可从本代事实独立重算且逐行完全一致；零分母为 not-applicable，real/injection/manual 分区完整，FinalizationSnapshot 验证后进入 `publication-ready`。默认本地 Authority 只能表述为 `local-crash-integrity`，报告不得从“检测 DB 单独回放”推导“抵抗同 UID 整体回滚”；只有实际绑定独立 `trusted-monotonic` provider 的本次证明才可声明更高等级。

## 暂停条件

事实/证据/签名缺失，审批缺失/重复/未知，追踪行缺失、重复、额外或错绑，verdict 无法复算、renderer 改变事实、XSS/路径逃逸或 generation 闭包失败。

## 禁止行为

不得手算 verdict/覆盖率，不得编造 disposition 状态或合成证据，不得用 diagnosis 替代 `workflow-events v2`，不得遗漏成功 Case 的 Attempt 诊断，不得用通过率推翻严格状态，不得混合 real/injection，不得隐瞒未执行项或先发布再生成结论。

## 独立调用

缺少必需 artifact/digest 时，只返回最小缺失项；不得重建上游，不得推进状态。
