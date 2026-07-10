# PRD 接入与身份

## 目的

规范化 PRD，并稳定确定 PRD-ID、Revision 与 Asset ID；只负责来源与身份，不进入测试设计。

## 触发条件

当用户提供 PRD、需求文档或其规范化正文，并需要开始一次 PRD 驱动验收时使用。

## 必需输入

产品空间、PRD 标题、非空规范化正文、测试工作区。

## 可选输入

用户提供的 PRD-ID、来源引用、版本标签、附件清单、现有 PRD manifest。

## 工作流

校验输入，规范化换行和标题，确定或请求确认 PRD-ID，计算 Revision，比较已有 Revision，再发布 PRD 资产。

## 详细算法

使用用户 PRD-ID；没有 ID 时按 sourceRef 提出建议，纯粘贴正文则等待确认。对正文和按稳定顺序排列的附件摘要计算 SHA-256 Revision。相同 PRD-ID 复用 Asset ID，内容变化只形成新 Revision 与 diff。保留来源、读取时间和附件摘要。

## 输出

normalized-prd.md、prd-manifest.json、prd-diff.json，以及可追溯的 assetId。

## 完成条件

PRD-ID、Asset ID、Revision 和来源都已确定，且产物通过 Schema。

## 阻塞条件

正文为空、来源不可读、同名 PRD 无法判定是否同一需求，或建议 PRD-ID 未获确认。

## 禁止行为

不得改写需求语义、从业务源码补充 PRD、记录秘密，或生成需求模型与测试 Case。

## 独立使用示例

已提供规范化 PRD 和 productSpace 时，输出当前 Revision 与首次执行的空变更集；缺 PRD-ID 的纯文本请求先向用户确认建议 ID。
