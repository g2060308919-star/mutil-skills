# PRD 接入与来源冻结

## 适用状态

`created → source-frozen`。

## 必需 Artifact 与摘要

`project-policy`、`prd-request`，以及可读取的 PRD 正文/附件引用；秘密只允许 secret ref。

## 允许的语义输出

来源候选、PRD-ID 建议和无法判定的身份问题。标准输出为 `prd-manifest`、`prd-diff`
（Schema 2.0.0）与 `semantic-generation` 候选。`prd-diff` 的决定前事实只包含 previous/current Revision、
sectionChanges、typed `lineageMappings` 和 impactedEntityIds；`lineageReview` 不进入自身 subject projection。
Core 只允许按 entityKind/semanticKey 精确对账；preserved 必须保持相同 ID，split/merged 必须
authority-confirmed，禁止标题相似度或模型猜测。

## 调用的确定性 API

调用 Contracts parse/migrate、`E2EEngine.ingest()`、Authority 来源签名和 Engine `transition()`；摘要、Revision
只采用 API 返回值。Lineage 决定必须由登记的 `lineage-approver` 通过专用 Decision key 签发
`lineage-decision-receipt/v1`，不得复用通用 Artifact key。

## 执行步骤

冻结正文与附件 bytes，记录来源和读取结果；让 Engine 生成稳定身份、Revision 和 diff；对显式
`lineage-decision-subject/v1` 展示并请求决定。Authority 生成 checkedAt/nonce；Engine 从本代 diff 重建
subject 并验专用 receipt 后，才追加 `source-frozen` 事件。

## 退出条件

来源集合不可变，manifest 覆盖全部正文/附件，Revision 可复算且事件已验签；approved/rejected 必须有
kind、decisionId、status 和 subject digest 全部匹配的 receipt，pending 必须没有 receipt。

## 暂停条件

正文为空、附件不可读、PRD 身份冲突、Lineage 决定缺失/验签失败或 Contracts major 不兼容；保存
`created` 为 resumeState。旧 `prd-diff` v1 一律 migration-required。

## 禁止行为

不得自行计算 SHA、从产品代码补写 PRD、复制 secret、生成规则/Case、猜测同名 PRD 身份，或用旧
Lineage receipt 覆盖 currentRevision、sectionChanges、lineageMappings、impactedEntityIds 的变化。

## 独立调用

缺少必需 artifact/digest 时，只返回最小缺失项；不得重建上游，不得推进状态。
