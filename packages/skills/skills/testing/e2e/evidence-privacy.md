# 证据、隐私与 Quarantine

## 适用状态

执行期间采集；`finalizing` 前完成发布证据审计。

## 必需 Artifact 与摘要

project evidence/privacy policy、`browser-results`、raw evidence refs、scanner/sanitizer 版本和 quarantine key ref。

## 允许的语义输出

采集范围、脱敏 finding、人工隐私复核请求和不能发布的证据说明；标准输出为 `browser-evidence` v2、专用 sanitizer attestation 与按需 PrivacyReview receipt。

## 调用的确定性 API

Skill 唯一调用固定 launcher `~/.mutil-skills/bin/repo-e2e rpc`，按 JSON stdin/stdout 发送严格 `RuntimeRequestEnvelope` 并解析严格 `RuntimeResponseEnvelope`。成功 `result` 必须拒绝未知字段并包含 `state`、`nextEdge`、`verifiedDigests`、`minimumMissingInput`；证据读取、脱敏、扫描、隔离与隐私复核均由 Runtime 内部执行，Skill 不接触原始 secret 或证据 bytes。

Runtime 内部必须调用加密 Evidence Vault、分类型 Sanitizer、scanner canary、`LocalSanitizerAuthority` 深接口、Authority privacy unlock/review 和 Engine evidence audit。调用方只能提交 raw bytes、evidence ID 与发布路径；不得提交任意 `SanitizationRecord` 请求签名。

## 执行步骤

raw bytes 直接写 Git 外 AES-GCM quarantine；按 DOM/console/network/screenshot/video/trace 分流；可信 runner 内部执行真实 sanitizer，再以专用 Ed25519 key 对 evidence ID、相对路径、完整 record 摘要、policy、output 及实际 sanitized bytes 的文件域/输出域摘要签 attestation。`blocked` 结果不得签名；`review-required` 可以签名，但 record 必须保持 `pending`。

`manualReview.required=false` 时，`privacyReviews` 只能写由有效 attestation、record 和 policy 推导的 `not-required`，不得伪造人工签名。`required=true` 时，只接受登记的 `privacy-approver` 使用专用 PrivacyReview key 对 evidence/path/file/output/proof/policy/decision/checkedAt 签发的 `approved` 或 `rejected` receipt；通用 Artifact 签名、自动把 record 改为 approved、缺失/过期/换 key receipt 均无效。

## 退出条件

每个发布 evidence 有 clean scan、兼容格式、可跨进程验签的专用 attestation，以及所需的真实人工决定；Engine 和 staging auditor 都从实际 bytes 重建全部绑定。quarantine 未进入 generation/Git 且按 TTL 销毁。

## 暂停条件

sanitizer/scanner 错误、未知格式、canary 失败、高敏 finding、遮罩跟踪失败或复核缺失。

## 禁止行为

不得把 `redacted: true` 当证明，不得复制 Cookie/Token/storageState，不得发布 raw evidence，不得用 Artifact 签名冒充 sanitizer/Privacy 签名，不得让 caller 传任意 record 换签名，也不得宣称 canary 证明不存在所有 PII。

## 独立调用

缺少必需 artifact/digest 时，只返回最小缺失项；不得重建上游，不得推进状态。
