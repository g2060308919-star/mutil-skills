# E2E Runtime Host 是唯一工作流权威

## 状态

Accepted

## 日期

2026-07-31

## 背景

PRD 驱动 E2E 包含来源冻结、范围、覆盖、审批、浏览器执行、副作用、Cleanup、证据、最终化和发布。若 Skill、CLI 和 Runtime 分别维护状态顺序、摘要或 verdict，恢复和审计会产生多个相互漂移的事实源。

## 决策

Runtime Host 是唯一 RPC、工作流和恢复权威。Skill 只负责一次需求理解、展示 Runtime review、获取调用者决定并调用高层 interface。Engine 独占覆盖和 verdict；Authority 独占审批与能力；Gateway 独占出站副作用事实。

## 备选方案

- Skill 自行维护状态和 Artifact 顺序：拒绝，因为删除 Skill 规则后复杂度会扩散到所有调用者。
- 新增外部 Controller：拒绝，因为会形成第二套持久状态和恢复权威。
- CLI 直接编排低层 package：拒绝，因为 CLI 应保持入口而不是领域所有者。

## 影响

- Runtime 必须提供高层编译和状态投影。
- Skill 不计算摘要、覆盖率、审批有效性或下一状态。
- 所有恢复使用 Runtime 持久事实，调用者不能自报已完成边。
