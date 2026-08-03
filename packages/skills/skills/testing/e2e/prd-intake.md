# PRD 接入与来源冻结

## 适用状态

`created → source-frozen`。

## 必需 Artifact 与摘要

`project-policy`、含 `understanding` execution projection 的 `prd-request`，以及可读取的 PRD 正文/附件引用；秘密只允许 secret ref。投影必须来自同一份已确认 requirements contract，携带 `confirmed-by-caller`、当前 `sourceRevision`、`projectionDigest`、完整 Source Bundle、REQ/RULE/FLOW 节点与 `pendingQuestions: []`。

这些属于 Skill 与 Runtime 的内部接入材料。不得要求调用者手工创建 `.biztest/project.json`、requirements contract、machine view、source bundle 或 project policy；Skill 自动准备相对 POSIX 路径的冻结文件并保留原始 origin，Runtime 只读取已冻结 bytes。已有项目身份和 policy 不得静默覆盖；无代码仓库时使用独立接入工作区，使 Run 不依赖 Git。

## 允许的语义输出

来源候选、PRD-ID 建议和无法判定的身份问题只能回到 `$understand-prd` 更新同一契约，不得在本阶段建立第二份摘要。标准输出为带完整 Clause Inventory 的 `prd-manifest`、`prd-diff`
（Schema 2.0.0）与 `semantic-generation` 候选。`prd-diff` 的决定前事实只包含 previous/current Revision、
sectionChanges、typed `lineageMappings` 和 impactedEntityIds；`lineageReview` 不进入自身 subject projection。
Core 只允许按 entityKind/semanticKey 精确对账；preserved 必须保持相同 ID，split/merged 必须
authority-confirmed，禁止标题相似度或模型猜测。

## 调用的确定性 API

Skill 唯一调用固定 launcher `~/.mutil-skills/bin/repo-e2e rpc`，按 JSON stdin/stdout 发送严格 `RuntimeRequestEnvelope` 并解析严格 `RuntimeResponseEnvelope`。每个业务命令成功后必须立即调用 `get-status`；只有严格拒绝未知字段的 `get-status` `result` 才提供 `state`、`nextEdge`、`verifiedDigests`、`minimumMissingInput`，其他命令结果不得用于猜测状态；来源读取结果与语义候选通过 `create-run`/`prepare-prd-understanding`/`submit-candidate` 交给 Runtime，Skill 不自行计算 `sourceRevision` 或 `projectionDigest`。

请求被拒绝时先读取 `error.details.validationIssues`，逐条向调用者展示字段 `path`、约束 `constraint` 和修复动作；路径、sourceSpan、安全 ID、空 locator name 与未知字段均按可修复输入问题处理。只有缺少业务事实或需要语义决定时才询问调用者，不得把严格 JSON envelope 或内部文件格式转嫁给调用者。

Runtime 内部必须调用 Contracts parse/migrate、`E2EEngine.ingest()`、Authority 来源签名和 Engine `transition()`；摘要、Revision
只采用 API 返回值。Lineage 决定必须由登记的 `lineage-approver` 通过专用 Decision key 签发
`lineage-decision-receipt/v1`，不得复用通用 Artifact key。

## 执行步骤

先把唯一 requirements contract 原文、主 PRD 和同一 Source Bundle 的 necessary-dependency 文件交给 `create-run`；Runtime 校验契约 front matter 与请求 Header 一致，并返回 `understandingContractDigest`、`sourceRevision` 和严格 Source Bundle。只使用这些返回值完成 execution projection 草稿绑定，再调用一次 `prepare-prd-understanding`；Runtime 持久化唯一 prepared projection，`prd-request.understanding` 必须逐字复用返回值。Runtime 必须验证 `contractVersion` 等于 authorization version、`pendingQuestions` 为空、route 唯一指向 `e2e`、授权节点集合完整、每个 `source-fact` 的 `sourceId` 存在，并按 `sourceSpan` 从冻结 bytes 回切逐字比对；`confirmed-decision` 保留决定引用，任何 inference 都不得伪装为 source fact。随后逐条登记 Clause 的稳定 ID、`sourceId`、原文、规范文本、摘要与 `sourceSpan`，并由 Runtime 复算唯一 `inventoryDigest`。让 Engine 生成稳定身份、Revision 和 diff；对显式
`lineage-decision-subject/v1` 展示并请求决定。Authority 生成 checkedAt/nonce；Engine 从本代 diff 重建
subject 并验专用 receipt 后，才追加 `source-frozen` 事件。

## 退出条件

契约原文与来源集合不可变，`understandingContractDigest`、`sourceRevision` 与 `projectionDigest` 均由 Runtime 验证，manifest 覆盖全部执行相关正文/附件和 Clause Inventory；每个契约来源锚点映射到同 sourceId、同 `sourceSpan`、同原文的 Clause，Clause ID 唯一、来源存在、`sourceSpan` 有效、单条摘要与 `inventoryDigest` 均可复算。Revision 可复算且事件已验签；approved/rejected 必须有
kind、decisionId、status 和 subject digest 全部匹配的 receipt，pending 必须没有 receipt。

## 暂停条件

正文为空、附件不可读、契约未确认、授权版本陈旧、`pendingQuestions` 非空、`sourceRevision`/`projectionDigest` 漂移、source fact 与冻结原文不一致、契约节点未映射、Clause 丢失/重复/来源未知/区间无效/摘要漂移、PRD 身份冲突、Lineage 决定缺失/验签失败或 Contracts major 不兼容；保存
`created` 为 resumeState。旧 `prd-diff` v1 一律 migration-required。

## 禁止行为

不得第二次调用 `$understand-prd`、不得从产品代码补写 PRD、不得把 inference 标为 `source-fact`、不得自行计算 SHA、不得复制 secret、不得生成规则/Case、不得猜测同名 PRD 身份，或用旧
Lineage receipt 覆盖 currentRevision、sectionChanges、lineageMappings、impactedEntityIds 的变化。

## 独立调用

缺少必需 artifact/digest 时，只返回最小缺失项；不得重建上游，不得推进状态。
