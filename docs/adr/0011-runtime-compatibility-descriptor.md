# ADR 0011：Runtime 兼容事实描述符

- 状态：Accepted
- 日期：2026-08-08
- 行为基线：`v0.5.2`

## 背景

Runtime 已经分别维护严格 RPC 协议、Snapshot 迁移注册表、内容寻址 Artifact Schema Set、声明式 PRD Design Schema、capability-branded Browser Executor 和精确 installation digest 绑定。它们可以安全执行当前 E2E，但调用者没有一个只读边界能判断“当前 Runtime 明确支持什么”。

直接实现自动更新会把版本选择与上述事实混在一起，并可能错误地让活跃 Run 切换 Runtime。另建一套兼容数据库又会与真实协议和迁移器漂移。

## 决策

1. 新增严格 `RuntimeCompatibilityDescriptorV1Schema` 和 `RuntimeCompatibilityDescriptorV1`。
2. 新增 `describeRuntimeCompatibility` 只读投影函数。它不联网、不安装、不选择版本、不移动 current 指针、不迁移 Run。
3. Descriptor 只声明当前能够从代码和已验证输入证明的事实：
   - Runtime package、Node 范围和 RPC protocol；
   - 当前 Snapshot Schema、迁移注册表覆盖范围及旧版本限制；
   - 内容寻址 Artifact Schema Set digest；
   - PRD Design Schema 版本；
   - 当前 capability-branded Browser Executor 能力名；
   - 活跃 Run 的精确 installation digest 绑定与禁止自动升级。
4. Snapshot 兼容版本从现有 `RuntimeStateMigrationRegistry` 投影，不创建第二个迁移版本列表。
5. Artifact Schema Set digest 和 installation digest 必须来自已经验证的边界。Descriptor 只做格式与结构校验，不把调用者提供的摘要升级为签名或授权事实。
6. Descriptor 是兼容信息，不是 Policy Decision、Authority Grant、Executor Capability 或 Resolver 更新清单，安全决策不得只依赖它。
7. 本阶段只导出 package API，不增加 RPC 命令或 CLI 状态迁移；既有用户流程与 `v0.5.2` 输出保持不变。

## 兼容性

- 变更是 additive export，不删除或修改现有 export。
- RPC `1.0.0`、CLI、Workflow、Run Store、制品和报告格式不变。
- 已创建 Run 仍绑定创建时的 `runtimeInstallationDigest`。
- `submit-candidate` 继续保留在当前正式链路。

## 安全边界

- `automaticUpgrade` 在 V1 中固定为 `false`。
- 任意格式错误、未知字段、乱序/夸大版本或 capability 声明都会被严格 Schema 拒绝。
- 后续 Resolver 必须使用独立的签名更新清单与已验证安装事实，不能信任未经验证的 Descriptor 输入。
- 在线 stable/latest 和 LKG 不属于本 ADR 的实现范围。

## 验证

- Contracts 测试证明严格 Schema、未知字段拒绝、精确安装绑定和禁止自动升级。
- Runtime 测试证明输出与 Runtime package 版本、迁移注册表、current pointer、正式 Artifact Schema pointer 和 RPC major 一致。
- Public exports 测试证明只新增预期的安全 API，没有暴露 Runtime Host、Run Store、Installer 或 Secret Broker。
- 全量类型、架构和测试门禁继续运行；真实浏览器 Golden 只在具备 loopback 和 Chrome 权限的支持宿主执行。
- PR 和手动验证使用独立的无发布权限 macOS Golden workflow；npm 发布仍只允许不可变 tag workflow 在 Golden 通过后执行。
