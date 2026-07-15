# PRD 驱动 E2E 系统 V2：任务清单

## Phase A：安全和契约骨架

- [x] Task 1：接入六个 E2E workspace package
- [x] Task 2：Artifact Envelope、Canonical Digest 和稳定错误
- [x] Task 3：结构化模型与覆盖闭包
- [x] Task 4：权威工作流最小状态机
- [x] Checkpoint A：契约、安全骨架与全仓回归通过

## Phase B：最小只读真实浏览器闭环

- [x] Task 5：本地 Approval Authority 只读签发与验证
- [x] Task 6：Gateway canonical request 与只读 allowlist
- [x] Task 7：确定性 Playwright 只读编译器
- [x] Task 8：Chromium 只读 runner 与最小证据（使用系统 Chrome）
- [x] Task 9：最小 Verdict 和离线报告
- [x] Task 10：单 generation 最小事务发布
- [x] Task 11：只读 Golden Tracer Bullet
- [x] Checkpoint B：真实浏览器只读闭环通过

## Phase C：写入、租约与清理

- [x] Task 12：Lease Authority 与 tentative/active lease
- [x] Task 13：reversible-write capability
- [x] Task 14：VerificationPlan 与 cleanup
- [x] Task 15：可恢复写 Golden 场景
- [x] Checkpoint C：签名 capability、Lease fencing、真实写入、双探针、清理与报告闭环通过

## Phase D：故障注入与诊断

- [x] Task 16：InjectionCapability、签名响应模板、Gateway 分阶段注入与计数闭包
- [x] Task 17：协议分类、签名 SSE/WebSocket 约束与逃逸通道阻断
- [x] Task 18：诊断优先级、effect-aware 重试、自愈审查与签名 attempt 事件链
- [x] Task 19：真实 Chrome 500/timeout 注入、locator 自愈与协议逃逸 Golden
- [x] Checkpoint D：注入、协议阻断、签名重试链、模式分区与零上游写闭环通过

## Phase E：证据、隐私和恢复

- [x] Task 20：AES-GCM Quarantine、Secret Provider、TTL、RBAC 审计与 crypto-erasure
- [x] Task 21：分类型 Sanitizer
- [x] Task 22：ManualResult 与完整 Verdict 真值表
- [x] Task 23：完整 27 Artifact Schema 与引用图审计
- [x] Task 24：Artifact kill-point/GC 恢复矩阵
- [x] Checkpoint E：隐私、Schema 和恢复通过

## Phase F：Skill 与最终验收

- [x] Task 25：升级中文 E2E Skill 与 runtime prerequisites
- [x] Task 26：完整报告
- [x] Task 27：30 个系统 E2E 场景
- [ ] Task 28：最终架构、安全、隐私和 QA 审计
- [ ] Final Checkpoint：全量命令和 SPEC 追踪通过

## 当前任务

- [x] Task 15 GREEN：真实 Chrome 受控写入、清理与同代报告闭环
- [x] Task 16 GREEN：500/reset/timeout/empty/boundary 注入与零目标转发证明
- [x] Task 17 GREEN：Service Worker、WebSocket 写帧、Beacon、iframe 与未知协议 fail-closed
- [x] Task 18 GREEN：业务/unknown 不重试、语义修改拒绝、final attempt 可复算
- [x] Task 19 GREEN：real/injection 分区、零上游写、自愈与逃逸探针闭环
- [x] Task 20 GREEN：Git 外加密存储、隐私解锁、过期/发布销毁与审计链
- [x] Task 21 GREEN：分类型 Sanitizer、隐私扫描、证明元数据与 fail-closed
- [x] Task 22 GREEN：Authority 签名 ManualResult、Attempt 验链与完整 Verdict 真值表
- [x] Task 23 GREEN：27 类严格 Schema、版本化 JSON Schema 集、Authority/Gateway 签名与完整 generation 引用图/文件/verdict 复算
- [x] Task 24 GREEN：完整发布审计、POSIX advisory lock/fencing、双槽 journal、全原子 kill-point、签名 validation refs 与幂等 GC 恢复
- [x] Task 25 GREEN：中文入口、14 个按状态加载子流程、Engine WorkflowDecision 单一状态源与 8 项 fail-closed Runtime capability
- [x] Task 26 GREEN：final-report 2.0.0 严格事实契约、15 章 JSON/Markdown/离线 HTML、证据链接安全、Case 筛选/展开/打印与真实 Chromium 验证
- [x] Task 27 GREEN：30 个场景均有真实系统证据；方案 B 的可信编译与 Source Set 证明替代通用代码隔离后端依赖，但不宣称 production-isolated
- [x] Task 28 GREEN：最终外审缺口闭合——Engine readiness 校验真实 PRD/scope/lineage、审批 runId 进入 Compiler Input、只读 Bridge 按 Case→Action 收齐结果并以内容 digest 绑定同次证据、Host 独立测量 Chrome/Proxy、staging 对账 approval/Case/exitCode/运行时测量、token 级 fetch guard 扫描
