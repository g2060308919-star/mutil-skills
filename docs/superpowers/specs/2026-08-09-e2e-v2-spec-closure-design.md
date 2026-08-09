# E2E Runtime V2 架构补完设计

日期：2026-08-09
状态：已批准设计的补完实施基线

## 1. 目标

本轮不改变 PRD 驱动 E2E 的既有领域模型，而是关闭 V2 方案中尚未形成生产证明的五类缺口：

1. 签名 Runtime 更新的元数据寿命、撤销和审计闭环；
2. Browser Executor Protocol 覆盖读、可逆写、注入与 full-playwright；
3. 以真实执行结果衡量 B 端场景覆盖率，而不是用“支持某个 API”代替覆盖证明；
4. 在稳定宿主上证明 p95 与非功能基线，并在普通 CI 中明确标记不可作为发布门禁；
5. 为生产 stable 源提供可复核的上线、撤销和恢复工具链。

## 2. 不变量

- 已绑定 Run 永远使用原 installation digest，更新不得偷偷换版本。
- 已撤销的 installation digest 对新 Run 和旧 Run都必须 fail closed。
- 写动作、注入和 full-playwright 不因协议迁移而重复执行；未知副作用只能进入 reconcile。
- `legacy` 仍是默认路由，只有 shadow 等价性 Golden 全绿后才允许单独批准切换权威路由。
- 任何本地或 GitHub-hosted runner 的性能结果都不得伪装成稳定宿主门禁结果。
- 测试信任根和私钥不得进入 npm 包；生产信任材料属于外部运维输入。

## 3. Runtime 更新信任闭环

### 3.1 元数据最大剩余寿命

在更新开始时同时验证“尚未过期”和“不会活得过久”：root 365 天、targets 30 天、snapshot 7 天、timestamp 24 小时。超过上限返回 `E2E_RUNTIME_UPDATE_METADATA_EXPIRY_TOO_LONG`。该规则阻止被错误签发的长期 metadata 扩大密钥泄露窗口。

### 3.2 可持久撤销事实

更新状态升级为 `1.1.0`，增加最多 256 条撤销记录，主键为 runtimeVersion + installationDigest，保存原因码、targets metadata 版本和观测时间。读取时兼容 `1.0.0` 并确定性迁移为空撤销集；写回只产生 `1.1.0`。

刷新到已撤销 target 时，必须先持久化 metadata 高水位和撤销事实，再返回 `E2E_RUNTIME_UPDATE_TARGET_REVOKED`。Resolver 对已有 Run 注入撤销检查器：命中撤销即返回安全阻断；可信 metadata 有效且未命中为 `revocation-checked`；已过期为 `metadata-expired`；没有可信状态为 `offline-unchecked`。

### 3.3 可复核审计

每条新审计事件增加 channel、Node major、platform/arch、四角色 metadata 版本与摘要，以及 default/LKG 变更前后值。旧事件迁移为显式 `legacy` 事实，避免伪造当时不存在的数据。审计不记录 token、URL 凭证或环境变量。

## 4. Browser Executor Protocol 闭环

协议层提供四个正式路由函数：read、reversible-write、injection、full-playwright。Host 的路由配置按执行类型独立选择 `legacy` 或 `shadow`。

shadow 路由只调用一次旧执行器，然后分别用独立旧语义读取器和协议 projector 投影并 fail-closed 比较。写与 full-playwright 若 `effectObservation=unknown`，协议结果必须为 `reconcile`；不得自动重试。取消与 deadline 保持“dispatch 前可取消”的真实能力声明，不夸大为运行中强制中断。

恢复路径同样经过 full-playwright 协议路由，避免正常执行与恢复执行形成两套语义。

## 5. B 端场景覆盖证明

建立版本化、机器可读的加权场景语料库，覆盖：表格、过滤、分页、表单、日期、富文本、上传、角色权限、状态流转、iframe 与常见组件交互。每个场景必须绑定 Requirement、Rule、Oracle、Case、执行结果和证据；仅声明 capability 不计分。

覆盖率定义为：成功闭环场景权重之和 / 全部必选场景权重之和。发布门禁同时要求：

- 总加权覆盖率不低于 90%；
- 每个必选类别至少一个真实通过场景；
- 负样本能够被判失败，避免只测 happy path；
- 重复执行没有 flaky 结果；
- 任何环境跳过都会使结果 `gateEligible=false`。

## 6. 性能与非功能证明

在现有大规模编译基准上补充 Runtime 启动、更新检查冷/热路径、并发新 Run 解析、错误诊断分类和证据保留验证。报告必须记录 Node、OS、CPU、runner 标识、样本数、p50/p95/max 和原始结果摘要。

普通开发机与 GitHub-hosted runner 只生成趋势报告；只有配置了仓库批准的稳定 self-hosted runner 标签和基线文件，才可产生 `gateEligible=true`。缺少稳定 runner 时 CI 必须明确失败或标记非门禁，不得静默跳过后宣称完成。

## 7. 生产 stable 上线边界

仓库提供：离线根签名仪式检查、metadata 发布前验证、origin 健康检查、撤销演练和 LKG 恢复演练。生产私钥、最终 trusted root、HTTPS metadata origin、稳定 runner 和发布权限均为外部运维输入；代码可完成所有前置验证，但不能生成或代管这些生产资产。

生产启用条件为：真实 root 阈值签名通过、所有角色寿命符合上限、origin 与 registry allowlist 生效、撤销演练阻断新旧 Run、LKG 演练成功、稳定 runner 的覆盖与性能门禁全绿。

## 8. 交付与版本

安全闭环、协议全路径、覆盖证明、非功能证明和生产运维工具均完成后发布一个 minor 版本。若外部信任材料或稳定 runner 尚未提供，代码仍可发布为“生产激活受门禁”，但文档与报告必须准确列出未满足条件，不能把测试 fixture 当作生产完成证明。
