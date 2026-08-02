# understand-prd 单次契约交接

## 适用状态

在创建 E2E Run 之前执行。若调用者已提供当前、已确认、`pendingQuestions` 为空且 execution projection route 精确指向 `e2e` 的 requirements contract，直接消费该版本；否则优先恰好调用一次已安装的 `$understand-prd`。若外部 Skill 不可用，本文件就是内置等价流程：在当前 E2E Skill 内完成一次来源收集、节点化、问题闭合和调用者确认。外部与内置路径互斥，同一目标只能执行一次，也不得创建平行的需求总结、交接文档或决定清单。

## 必需 Artifact 与摘要

唯一 requirements contract、执行相关 Source Bundle、当前 `contractVersion`、REQ/RULE/FLOW 原子节点、source/decision anchors、授权节点集合、E2E route 和调用者确认状态。每个来源必须标注唯一角色：`target` 是本次被验收的 PRD/页面，`reference` 只帮助理解且不得产生覆盖 obligation，`necessary-dependency` 是执行目标需求不可缺少的规则或附件。进入 Runtime 的不是第二份契约，而是同一契约的 execution projection；Runtime 冻结契约原文并生成、验证当前 `sourceRevision`、`understandingContractDigest` 与 `projectionDigest`。契约中的全局背景和 out-of-scope 仍保留在唯一契约中，但不得伪装为本次执行来源，参考页面不得进入验收范围。

## 允许的语义输出

`$understand-prd` 可以收集目标相关来源、建立全局关系和目标边界、拆分 REQ/RULE/FLOW、调查缺口、批量询问必要问题，并在后续回复取得当前契约版本确认。E2E 只允许把已确认契约投影成严格机器字段，不得新增需求事实。来源原文事实使用 `source-fact`，用户明确决定使用 `confirmed-decision`；推断必须在 understand-prd 阶段解决或保留为问题，不能进入已确认投影。

## 调用的确定性 API

Skill 只通过固定 launcher `~/.mutil-skills/bin/repo-e2e rpc`，以 JSON stdin/stdout 发送严格 `RuntimeRequestEnvelope` 并解析严格 `RuntimeResponseEnvelope`。`create-run` 同时冻结唯一 requirements contract 原文、主 PRD 与 supporting sources，校验契约严格 front matter，并返回 Runtime 计算的 `sourceRevision`、`understandingContractDigest` 与 Source Bundle 元数据；`prepare-prd-understanding` 校验不带摘要的投影草稿、持久化同一 Run 唯一不可变 prepared projection，并返回带 `projectionDigest` 的严格投影；随后 `submit-candidate` 必须逐字复用该返回值。每个业务命令成功后立即 `get-status`，只消费严格 `state`、`nextEdge`、`verifiedDigests` 与 `minimumMissingInput`，不得自行计算摘要或猜测工作流。

## 执行步骤

1. 判断当前对话是否已有唯一契约。仅当契约状态已确认、版本明确、目标节点全部授权、`pendingQuestions` 为空且 route 指向 `e2e` 时复用；否则仅选择一条路径：调用一次已安装的 `$understand-prd`，或在其不可用时执行本文件的同等调查与确认步骤。
2. 为唯一契约写入严格 front matter：`schemaVersion`、`contractId`、`contractVersion`、`contractStatus`、`confirmationStatus`、`confirmationContractVersion`、`confirmedAt`；并嵌入唯一 `e2e-contract-machine-view:v1` JSON 区块，逐字保存 nodes、provenance/confirmed-decision、pendingQuestions、route 与 authorizedNodeIds。Runtime 会冻结整份原文并要求 execution projection 与该区块完全一致；该投影是机器视图，不是新的需求资产。
3. 将契约原文、唯一 `target` 主 PRD 与 `necessary-dependency` 来源作为 `create-run` 文件来源提交。`reference` 只保留在 Skill 的 intake 说明中，不提交为 Runtime requirements source，也不得进入验收范围、Case coverage 或 verdict；如果其中某条规则确实不可缺少，必须先明确重分类为 `necessary-dependency` 并说明理由。一个 Run 只能有一组目标边界。URL 或文本来源必须先获得有界、可复读的本地快照，并在投影 `origin` 中保留原始 kind/ref；不得让 Runtime 在执行期读取漂移网页。主来源与依赖来源合计不得超过 Runtime 公布的 8 MiB 上限。
4. 读取 Runtime 返回的 `sourceRevision`、`understandingContractDigest` 和 Source Bundle 元数据，只把这些机器值绑定进投影草稿；调用一次 `prepare-prd-understanding`，由 Contracts/Runtime 复算、持久化并返回 `projectionDigest`。重复相同请求可幂等重放，不同投影会被拒绝；Skill 不得自行计算摘要或替换 prepared projection。
5. Runtime 严格验证契约版本与 authorization version 相等、投影 machine view 与冻结契约正文完全一致、授权节点集合与投影节点集合相等、route 覆盖全部节点、Source Bundle 的 snapshot path/digest/length、原始 `origin` 与 `relevance` 全部一致、每个 `source-fact` 的逐字 quote 与 `sourceSpan` 回切结果一致。缺失引用、伪造来源或引文、过期版本、未解决问题或 inference 伪装都进入 `input-blocked`。
6. 后续 `prd-manifest` 必须把每个来源锚点映射成同 sourceId、同 sourceSpan、同原文的 Clause；每个 Requirement、Rule 与 Flow 都必须通过 `contractNodeIds` 引用当前契约节点，每条契约验收条件都必须通过 `contractAcceptanceCriteria` 完整且唯一地映射到 Oracle。Oracle 再由既有 Coverage → Case → Step → Evidence 链闭合，不能反向改写契约。
7. Scope/Lineage 与 Execution Approval 仍按 Runtime 安全边界执行。`confirmed-by-caller` 只证明调用者确认了需求契约，不验证自然人身份，也不等于 Authority 签名。Execution Approval 授权的是实际环境、浏览器动作、网络请求和副作用，不是第二次 PRD 理解。

## 退出条件

唯一契约版本已确认，`pendingQuestions` 为空，契约原文与 Source Bundle 完整可冻结，全部目标节点进入 E2E route；Runtime 已保存唯一 prepared projection、接受逐字相同的 `prd-request.understanding`，并在 `verifiedDigests` 中提供当前来源与投影绑定。调用者能从契约节点追到 Clause、Requirement、Rule、Oracle、Case 和最终证据。

## 暂停条件

缺少 `$understand-prd` 且没有可复用契约、来源不可读取、目标相关来源缺失、契约版本或授权版本不一致、仍有待决问题、route 不覆盖全部节点、来源引文无法回切、sourceRevision 漂移、projectionDigest 复算失败，或 Runtime 返回 `minimumMissingInput`。此时只报告最小缺失项，不继续来源冻结后的边。

## 禁止行为

不得为了开始 E2E 再跑一次完整 PRD 访谈；不得把聊天摘要、页面观察、产品代码或模型推断冒充契约事实；不得把 `confirmed-by-caller` 写成已验身份审批；不得修改 source refs 以适配测试；不得让 E2E 派生资产成为第二需求真相；不得绕过 `~/.mutil-skills/bin/repo-e2e rpc` 或 JSON stdin/stdout 协议直接写 Runtime 状态。

## 独立调用

缺少必需 artifact/digest 时，只返回最小缺失项：`contractVersion`、未闭合问题、不可冻结来源或 Runtime `minimumMissingInput` 中的最小集合；不得重建上游，不得推进状态。若已存在合格契约，必须复用而不是重新调用 `$understand-prd`。
