# ADR 0015：PolicyDecisionViewV1 统一语义但保留双重执行时点

## 状态

Accepted，2026-08-08。

## 背景

E2E 已有两类必要且不同的 Policy 事实：Authority 在执行前签发并复验计划级 Grant；Gateway 在每个真实网络动作发生时按冻结 capability、请求、次数、lease 和 target 再次执行强制校验。两者使用不同结构，报告只能分别展示审批摘要与 Gateway 计数，用户无法追踪某个 Action 的批准边界和实际执行决策。若把两层合成一个“已批准”布尔值，又会让整体批准错误替代请求时校验。

## 决策

1. 新增 `PolicyDecisionViewV1`，作为既有 Authority freshness receipt 和 Gateway signed request event 的确定性只读投影；不新增策略数据库、Artifact 类型或写入 API。
2. Authority 投影固定为 `source=approval-freshness`、`stage=plan-approval`，逐 capability 绑定 asset、PRD revision、subject、run bundle、target origin、Action、Capability 摘要、operation、Policy、payload/target fingerprint、lease/fencing/cleanup 和 Authority 证据。
3. Gateway 投影固定为 `source=gateway-enforcement`、`stage=action-enforcement`，绑定 Gateway instance、Policy、Action、event sequence、可用的 execution session/result/domain 和 signed event digest。
4. Gateway publication event 当前没有持久化阻断原因码，投影必须保留空 `reasonCodes`，不得由 Report 臆造。原因码后续只能通过升级权威 Gateway 事件契约加入。
5. Final Report 同时携带两类视图并按 `decisionId` 确定性排序；Schema 校验每个 ID 绑定完整内容，Engine 独立事实审计复算集合，Markdown/HTML 以同一表格展示但明确标注执行时点。
6. 计划级批准绝不绕过 Gateway；Gateway forwarded 也不等价于范围、需求或执行计划整体获批。现有 Authority/Gateway 执行顺序、签名、reservation 和 Verdict 不变。

## 后果

- 用户可从同一报告看到“批准了什么”与“真实请求时执行了什么”。
- 重复风险分类被移除，但双重强制边界没有降级。
- 报告增加机器可读字段和表格；由于 Final Report 是代际生成资产，不修改历史代际。

## 回滚

停止生成和展示 `policyDecisions`，移除 Final Report 字段与投影导出。Authority receipt、Gateway audit、Verdict 与执行链保持原状，无需迁移权威状态。
