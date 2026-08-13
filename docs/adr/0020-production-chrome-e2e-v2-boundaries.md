# ADR 0020：Production Chrome E2E V2 的产品边界与恢复权威

## 状态

Accepted，2026-08-12。

## 背景

Chrome E2E 已具备 RuntimeHost、Engine、Authority、Gateway、受控浏览器、Artifact Store 与完整报告，但发布事实、PRD 到执行资产、真实项目证明、Fixture 生命周期、产品 Facade、取消/健康、自愈、性能和解释曾分散在多个入口。若通过新增第二套 controller 或允许调用者提交可信摘要来补齐，会破坏已有安全边界。

## 决策

1. RuntimeHost 继续是唯一 Run 状态和恢复权威；Engine 独占 workflow/Verdict/自愈语义审阅，Authority 独占 Grant/Lease/fencing，Gateway 独占网络转发事实，Report 只渲染。
2. PRDRunCompiler 采用“不可信声明式候选→Runtime 确定性规范化/复算→Runtime-owned Artifact 事务提交”。调用者不得提交 digest、Approval、Evidence、Verdict 或 Artifact 顺序。
3. 高层 E2EFacade 只执行 Runtime 返回的下一合法边。Probe、Preflight、Execute、Finalize 可自动推进；语义审阅、绑定、Scope/Lineage/Execution Approval 和高风险副作用必须暂停为 typed decision。
4. localhost/fixture 可证明真实 Chrome 下的 browser-product 行为，但 backend、database、IdP 只有在真实受控组件被执行并产生独立证据时才可 verified；否则必须标记 substituted/not-executed/not-verified。
5. Fixture 资源必须按 Run/Attempt namespace 和 Lease fencing 隔离。Cleanup 失败或 Reload 仍可见必须阻止 accepted、保留 residual，并只做 owner resource 收敛；不确定写禁止自动重放。
6. Bounded Healing 只能改变已证明安全的 locator/scope/明确 wait。它必须绑定原 Attempt/page/evidence，经过 Engine review，生成新 revision 和新 Attempt，重跑全部相关 Oracle；任何语义、权限、Target、effect、network、Oracle 或 Fixture 变化都拒绝。
7. Timeline、Failure Explanation 与 Claim Classification 从 active final-report 的已验签事实投影为可携带 JSON/Markdown/HTML sidecar，不参与 Verdict 计算。
8. 性能和发布结论必须区分 `passed` 与 `gateEligible`。普通开发机 proof 可用于趋势和故障发现，但不能冒充 stable runner、生产 TUF、Registry Golden 或声明支持平台的发布门。
9. 架构治理以循环依赖、权威泄漏、public/test capability 泄漏、耦合/热点/恢复边界为证据；文件行数只报告，不触发机械拆分。

## 后果

- 用户入口更短，但人工确认和安全审批不会被隐藏。
- Mock/localhost 的结论更保守，不会外推后端或身份系统已通过。
- 自愈与恢复的实现成本更高，因为每次 revision 都必须重新闭合摘要、批准、Attempt、Oracle 与 Evidence；换来的是不误点、不重放未知写和可审计。
- 本机全绿不等于可发布；stable runner、真实 TUF/签名材料和 Registry 仍是独立生产基础设施门。

## 回滚

Facade 自动边可以回滚为逐步调用而不改变历史 Run；解释 sidecar 可停止发布而不改变 final-report/Verdict；Healing 可禁用并回到人工修订新 Generation。不得通过回滚绕过 RuntimeHost、Authority、Gateway 或 Engine 的权威边界。
