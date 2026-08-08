# ADR 0014：AssertionResultV1 只读投影 OracleCheckpointResult

## 状态

Accepted，2026-08-08。

## 背景

浏览器执行已经把 Oracle 的 expected、actual、status 和 evidence IDs 持久化为 `OracleCheckpointResult`，Engine 也只基于这些执行事实、覆盖与 Policy 计算 Verdict。外部消费方和报告需要统一的 Assertion 语言，但新增可独立写入的 Assertion Artifact 会复制事实并允许与 checkpoint 漂移。

## 决策

1. `AssertionResultV1` 是 `OracleCheckpointResult` 的逐字段确定性只读投影，不新增 Artifact 类型、数据库表或写入命令。
2. `checkpointId`、`oracleId`、expected/actual 规范 JSON 和摘要、status、evidence refs 必须全部来自同一 checkpoint。
3. Assertion Schema 独立复验规范 JSON、摘要、status 与 expected/actual 的关系，以及 evidence ref 唯一性。
4. 新版 Final Report Step 在保留 `oracleCheckpoints` 的同时附加 `assertionResults`；Final Report Schema 要求两者精确等价。历史报告不含这两个字段时仍然有效。
5. Markdown/HTML 只展示 Assertion 投影；Report 不根据 Assertion 重新判断 Case 或最终 pass/fail。
6. Verdict、coverage、diagnosis、healing 和 Case Schema 本阶段保持不变。

## 后果

- Runtime、Report 和外部消费方获得统一断言语言。
- Checkpoint 继续是唯一断言事实源，无法通过只改报告伪造 Assertion。
- 新报告会增加可选字段，旧报告无需迁移。

## 回滚

停止生成和展示 `assertionResults`，再移除可选 Schema 字段和投影导出即可。历史 checkpoint、Verdict 和 Artifact 无需迁移。
