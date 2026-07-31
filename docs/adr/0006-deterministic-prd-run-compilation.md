# Requirements Contract 确定性编译为 PRD Run

## 状态

Accepted

## 日期

2026-07-31

## 背景

Runtime 不能从自然语言猜测 selector、页面动作或预期，也不能让模型成为摘要、引用和执行计划的可信权威；但让 Skill 手工提交十几种低层 Artifact 同样容易遗漏或错绑。

## 决策

Skill 可以提出严格的 Declarative E2E Design，只包含 Case、Action、Oracle、定位候选、网络和 Cleanup 意图。PRDRunCompiler 把它与已确认 Requirements Contract 的节点和验收条件逐项绑定，独占规范化 ID、摘要和 Run 计划。遗漏、篡改、重复或未授权的验收映射全部失败关闭。

## 备选方案

- Runtime 内嵌模型：拒绝，因为同一输入不能保证确定性，模型也不能成为安全权威。
- Skill 生成完整 Artifact：拒绝，因为暴露内部拓扑并降低 locality。
- 接受任意 Playwright/Node 源码：拒绝，因为会越过可信 Compiler 和宿主隔离边界。

## 影响

- Requirements Contract 仍只执行一次理解并保持唯一。
- Runtime 接受声明式候选，但不接受调用者自报 digest、签名、状态和 verdict。
- 受信 Playwright source 只能从已批准的声明式输入生成。
