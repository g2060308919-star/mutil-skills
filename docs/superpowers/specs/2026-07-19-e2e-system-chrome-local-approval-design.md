# E2E 系统 Chrome 与本地确认模式设计

## 1. 背景与目标

当前 E2E Runtime 强制每位用户下载由 Runtime 管理的 Chromium，并在任何受信 Run 前登记 WebAuthn 身份。该模型提供强复现和强人类在场证明，但对单人、本地或普通测试环境的 E2E 使用成本过高。

本次调整达成两个目标：

1. 默认复用操作系统已安装的 Google Chrome 可执行文件；Runtime 仍为每个受控浏览器会话创建独立的一次性 Profile，强制目标流量经过 Safety Gateway，并在确认 Chrome 进程退出后安全删除 Profile。只有系统 Chrome 不存在、不可执行或无法通过受控启动证明时，才提示用户显式安装托管 Chromium。
2. E2E 层默认认为所有能够调用 E2E Skill 的本地使用者都有批准资格，不维护审批用户、角色或权限列表。默认审批模式改为 `local-confirmation`；纯只读流程自动推进，高风险操作要求绑定当前不可变执行主题的明确本地确认。WebAuthn 保留为可选增强模式，不再是普通 E2E 的安装前置条件。

本次发布使用 `0.2.0` 版本闭包。原因是浏览器清单、Doctor 探针、审批证明和最终报告的安全语义发生变化；同版替换会触发既有安装器的内容冲突保护，也无法准确表达迁移边界。

## 2. 非目标

- 不连接用户已经打开的 Chrome 进程。
- 不读取或复用用户日常 Chrome Profile、Cookie、扩展、密码、LocalStorage、IndexedDB、Service Worker、客户端证书或账号登录状态。
- 不取消 Gateway、一次性 Profile、Secret Broker、Data Lease、Cleanup、Quarantine、可信编译和原子发布。
- 不允许生产环境或不可逆写操作因为本地确认模式而自动放行。
- 不把 `local-confirmation` 描述成已验证具体自然人身份、不可抵赖签名或多人职责分离。
- 不承诺任意 Chromium 内核浏览器兼容；首期系统浏览器只支持 Google Chrome stable。

## 3. 信任模型

### 3.1 默认授权模型

默认假设是：当前操作系统账号下能够调用固定 `repo-e2e` launcher 的本地使用者均有资格批准 E2E。Runtime 不维护 E2E 审批 ACL，不区分管理员、scope approver、executor 或 reviewer 的授权资格。

`local-confirmation` 只提供以下保证：

- 确认绑定当前 Run、项目身份、PRD Revision、执行主题摘要和有效期；主题变化后旧确认失效。
- Runtime 使用本地 Authority key 为确认事实、DecisionReceipt 和 Capability Grant 签名，后续执行不能改写已确认主题。
- 高风险流程必须经过两阶段 `open-approval → confirm-approval`，避免一次请求在展示主题前直接执行。

它不提供以下保证：

- 不证明具体自然人身份。
- 不抵抗完全控制当前 OS 用户账号的恶意进程。
- 不证明 executor 与 reviewer 是不同的人。
- 不提供跨机器或组织级审批权限管理。

最终报告必须将该等级写为 `local-confirmation`，并设置 `identityVerified=false`、`separationOfDutiesVerified=false`。只有实际启用并完成 WebAuthn 的 Run 才能声明 `webauthn-verified`。

### 3.2 风险分级

| 行为 | 默认处理 |
| --- | --- |
| PRD 读取、候选生成、摘要验证 | 自动允许 |
| 本地/测试环境只读 Scope、Lineage、Discovery 和 Execution | 主题完整且无歧义后自动签发本地确认事实 |
| 可逆写操作 | 必须明确本地确认，并继续绑定 Data Lease、次数和 Cleanup Plan |
| 故障注入 | 必须明确本地确认，仍由 Gateway 执行和计数 |
| 证据隐私解锁或人工结果最终化 | 必须明确本地确认 |
| 生产环境 | 默认 `safety-blocked`，Project Policy 不得用默认本地确认解锁 |
| 不可逆操作 | 默认 `safety-blocked` |

“所有调用者都有批准权限”不等于所有副作用自动执行。资格默认放开，但高风险主题仍需一次明确、可追踪且防陈旧的确认。

## 4. 系统 Chrome 架构

### 4.1 浏览器来源模型

新增严格 `BrowserSource`：

```ts
type BrowserSource =
  | { kind: 'system-chrome'; executablePath: string }
  | { kind: 'managed-chromium'; installationId: string }
```

用户级浏览器选择保存于 `~/.mutil-skills/e2e/state/browser-selection.json`，字段至少包含：

- `schemaVersion`
- `source.kind`
- canonical executable path
- Chrome version
- executable digest
- Runtime installation digest
- controlled-launch capability proof digest
- configuredAt

浏览器选择文件不得保存项目路径、用户 Profile 路径或任意 Secret。

### 4.2 CLI 选择流程

新增：

```bash
repo-e2e configure-browser --system
repo-e2e configure-browser --system --executable /absolute/path/to/google-chrome
```

无 `--executable` 时只从固定平台 allowlist 自动发现：

- macOS：`/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`。
- Linux：依次检查 `/usr/bin/google-chrome-stable`、`/usr/bin/google-chrome`、`/opt/google/chrome/google-chrome`。

不得从项目 `node_modules`、项目相对路径、任意 `PATH` 首项或 shell alias 发现浏览器。显式路径必须为绝对路径。

Runtime 对候选执行：

1. canonicalize 路径；最终对象必须是 root 或当前 UID 所有的可执行普通文件，并拒绝 group/world writable、项目目录内文件和路径替换。
2. 读取版本并计算 executable digest。
3. 使用现有 `ControlledBrowserHost` 创建一次性 Profile。
4. 启动临时 Gateway，完成代理、隔离、direct-bypass canary 和 cleanup proof。
5. 只有进程退出、Profile 清理和 proof 全部闭合后才原子保存选择。

现有命令保留为显式兜底：

```bash
repo-e2e install-browser
```

它继续安装并选择 `managed-chromium`，不得在系统 Chrome 配置失败后静默下载。

### 4.3 一次性 Profile

无论浏览器来源为何，均复用当前受控 Profile 机制：

```text
~/.mutil-skills/e2e/state/<runId>/browser/profile-<uuid>/
```

每次 `ControlledBrowserHost.open()` 创建一个 `0700` 新目录，并通过 `launchPersistentContext(profileDir, options)` 将其作为该会话唯一用户数据目录。系统日常 Chrome Profile 永远不进入 Runtime 输入。

Profile 正常生命周期：

```text
创建私有目录
→ 写 owner marker
→ 启动 supervisor
→ 启动独立 Chrome context
→ 执行本次会话
→ 请求关闭 Chrome
→ 确认进程已退出
→ 验证 owner marker/device/inode
→ 删除整个 Profile
→ 持久化 cleanup receipt
```

若关闭超时或无法确认进程退出，Profile 必须保留并进入 owned-resource recovery，不得冒险删除。恢复仅在进程死亡和所有权证明一致后清理。

### 4.4 Chrome 更新

系统 Chrome 可能自动更新。Doctor 每次重新读取 canonical path、版本与 executable digest。任一字段与选择记录不一致时返回：

```text
E2E_SYSTEM_CHROME_REVALIDATION_REQUIRED
```

并建议重新运行 `repo-e2e configure-browser --system`。Doctor 本身只读，不自动改写 proof，也不在后台下载浏览器。

## 5. 本地确认审批架构

### 5.1 审批模式

新增用户级配置：

```ts
type ApprovalMode = 'local-confirmation' | 'webauthn'
```

默认值为 `local-confirmation`。新增命令：

```bash
repo-e2e configure-approval --mode local-confirmation
repo-e2e configure-approval --mode webauthn
```

只有 `webauthn` 模式才要求：

```bash
repo-e2e identity enroll
```

从 `webauthn` 降级到 `local-confirmation` 不得让既有 WebAuthn Grant 自动转换；新 Run 使用新模式，旧 Run 继续按其创建时冻结的模式恢复。

Project Policy 的 environment 增加严格 `riskTier: 'local' | 'test' | 'staging' | 'production'`。旧 Policy 或未知环境没有 riskTier 时按 `production` 处理；默认本地确认不能解除该阻断。

### 5.2 两阶段确认协议

Contracts 新增 `confirm-approval` RPC。`open-approval` 的公共结果改为严格联合：

```ts
type OpenApprovalResult =
  | { status: 'approved'; approvalMode: 'local-confirmation' | 'webauthn'; receiptDigest: string }
  | {
      status: 'confirmation-required'
      approvalMode: 'local-confirmation'
      confirmationId: string
      subjectDigest: string
      expiresAt: string
      summary: LocalApprovalSummary
    }
  | { status: 'webauthn-required'; sessionId: string; url: string }
```

只读且满足自动批准策略的主题可在 `open-approval` 中直接由 Authority 签发。高风险本地主题必须先返回 `confirmation-required`；Skill 原样展示 `summary`，用户明确确认后发送：

```ts
{
  command: 'confirm-approval',
  payload: { runId, confirmationId, subjectDigest }
}
```

Runtime 在 Run lock 内重读项目身份、安装摘要、workflow state、完整 subject 和有效期。全部一致时，本地 Authority 才签发 DecisionReceipt 或 Capability Grant。confirmation 一次性消费；重复相同 request bytes 返回持久化 replay，不同 bytes 拒绝。

`LocalApprovalSummary` 只包含公开且有界字段：`runId`、`approvalType`、`environmentId/riskTier`、目标 origins、HTTP methods、Action 数、effect 分类、最大次数、secretRef 名称、Data Lease/Cleanup 引用、injection 分类、subjectDigest 和 expiresAt。不得包含 Secret value、请求 body、Cookie、绝对证据路径或原始 DOM。

### 5.3 自动批准边界

自动批准函数必须是 Runtime 内部纯函数，输入完整 approval subject 与 Project Policy，输出：

```ts
type LocalApprovalDisposition =
  | { kind: 'auto-approved'; reasonCode: 'E2E_LOCAL_READ_ONLY_AUTO_APPROVED' }
  | { kind: 'confirmation-required'; reasonCode: string }
  | { kind: 'blocked'; reasonCode: string }
```

只有所有 effect 均为只读、无 injection、无 privacy unlock、无 manual finalization、非生产环境且无不可逆行为时才能自动批准。未知 effect 固定阻断，不得降级成只读。

### 5.4 Authority 与报告

Authority 继续负责签名、freshness、nonce、撤销、use count、reservation 和 execution outcome；移除的只是默认模式中的 WebAuthn 人类身份认证，不移除 Capability 安全边界。

Approval artifacts、FinalReport 和 Markdown/HTML 必须增加：

```ts
{
  approvalMode: 'local-confirmation' | 'webauthn',
  identityVerified: boolean,
  separationOfDutiesVerified: boolean
}
```

本地模式不得填充伪造用户名、角色或 credential ID。既有报告审计必须验证三字段与真实 Authority outcome 一致。

DecisionReceipt 与 Grant 的 approver 字段升级为严格联合：`{ kind: 'local-caller' }` 或既有 WebAuthn identity。`local-caller` 不携带伪角色；需要 scope/lineage/execution role 的旧验证器按 ApprovalMode 选择策略，WebAuthn 模式保持原角色检查，本地模式只验证当前 Run 冻结的 mode、Authority 签名和主题绑定。

人工结果继续保留 executor、reviewer 两个流程步骤，但在本地模式允许同一 local caller 完成两次明确确认，并在报告中固定 `separationOfDutiesVerified=false`；WebAuthn 模式继续要求两个不同登记身份。每个 `finalize-manual-result-role` 都先返回自身的 confirmation challenge，不能用 executor 的确认完成 reviewer 步骤。

## 6. Doctor 与 Skill 行为

### 6.1 Doctor

Doctor 浏览器探针改为验证当前 `BrowserSource`。系统 Chrome 配置和受控启动 proof 有效时，`chromium`、`gateway`、`isolation` 均可通过，不要求 managed Chromium 安装。

审批探针按模式处理：

- `local-confirmation`：验证本地 Authority 和确认策略，WebAuthn enrollment 为 `not-applicable`，不影响 `ready`。
- `webauthn`：继续要求 enrollment、user verification 和 Authority 状态完整性。

Doctor 输出必须公开 `browserSource` 与 `approvalMode`，但不得公开绝对 Profile 路径、credential ID 或 Secret 状态。

### 6.2 Skill

E2E Skill 的启动建议改为：

```text
安装 Runtime
→ configure-browser --system
→ doctor --json
→ 开始 E2E
```

只有系统 Chrome 不可用时建议用户显式执行 `install-browser`。默认流程删除 `identity enroll`；只有 Doctor 显示 `approvalMode=webauthn` 且缺 enrollment 时才建议登记。

Skill 对 `confirmation-required` 只能原样展示 Runtime summary 并等待用户明确确认；不得自行改写 summary。对 `auto-approved` 继续推进。对 `blocked` 原样展示 reasonCode。

## 7. CLI 表面

用户级命令最终为：

```text
repo-e2e --version
repo-e2e install-runtime --version <exact>
repo-e2e uninstall-runtime --version <exact> [--activate <exact>]
repo-e2e configure-browser --system [--executable <absolute>]
repo-e2e install-browser
repo-e2e configure-approval --mode local-confirmation|webauthn
repo-e2e identity enroll                 # 仅 webauthn 模式
repo-e2e doctor [--json]
repo-e2e secret provide --run-id <id> --ref <ref>
repo-e2e report --run-id <id>
repo-e2e rpc                             # Skill 专用
```

既有 `approve` 人类命令保留用于兼容和诊断，但必须路由当前 ApprovalMode；本地模式不得伪装成 WebAuthn session。

## 8. 状态、迁移与失败恢复

- 七个 E2E package 统一升级到 `0.2.0`，内部依赖保持精确同版。
- Browser selection、Approval mode、Run snapshot、approval receipt 和 FinalReport 使用版本化 strict schema。
- `0.1.0` managed Chromium 安装可迁移为 `managed-chromium` selection，但旧 WebAuthn Run 保持 `webauthn`，不静默降级。
- 旧 Run 缺 approvalMode 时按 `webauthn` 迁移，避免改变既有批准含义。
- 系统 Chrome digest 变化、选择文件篡改、确认主题变化、过期或 replay 均 fail closed，并给出稳定 reasonCode。
- `confirm-approval` 在 Authority 已签发而 Run Store 尚未持久化时，使用稳定 finalization identity 恢复同一结果，不重复签发。

## 9. 测试策略

### 9.1 浏览器选择

- 固定 allowlist 自动发现系统 Chrome。
- 显式绝对路径配置。
- 拒绝相对路径、项目内恶意 Chrome、symlink swap、group/world-writable executable。
- 版本读取、digest 绑定和自动更新后 revalidation。
- 系统 Chrome 受控启动生成 Gateway/隔离 proof。
- 系统 Chrome 不可用时只给 remediation，不静默下载。
- managed Chromium fallback 保持工作。

### 9.2 Profile 与 Gateway

- 系统 Chrome 与 managed Chromium 使用完全相同的一次性 Profile 路径和 launch policy。
- 新会话不读取日常 Chrome Profile canary。
- 原 Chrome Cookie/LocalStorage canary 不出现在受控会话。
- 正常关闭删除 Profile 并产生 cleanup receipt。
- close timeout/存活进程时保留 Profile；恢复确认死亡后清理。
- 目标直连、未批准 Origin、redirect 和 method 继续阻断。

### 9.3 本地确认

- 默认模式无需 enrollment，Doctor ready。
- 纯只读 scope/discovery/execution 自动批准。
- write/injection/privacy/manual 返回 `confirmation-required`。
- subject 变化、过期、confirmation replay 和跨项目使用拒绝。
- 确认后签发的 Grant 仍执行 freshness、次数、Gateway reservation 和 outcome 验证。
- 本地模式报告不声明身份验证或职责分离。
- 可选 WebAuthn 模式保持原有 enrollment、UV、replay 和恢复测试。

### 9.4 集成与 Golden

- 空白项目从 `0.2.0` tarball 安装，配置系统 Chrome，不安装 managed Chromium，完成只读 PRD→报告全链。
- 可逆写 Run 在本地确认后执行并验证 cleanup。
- 无确认的写 Run 不启动浏览器业务 Action。
- 既有 Gateway、Secret、Quarantine、Compiler、Artifact Store 和报告 Golden 不回退。
- README、E2E Skill 和 Changelog 使用同一普通用户流程。

## 10. 验收标准

实现完成必须同时满足：

1. 一台已安装兼容 Google Chrome 的 macOS/Linux 机器不下载 managed Chromium，也能使 Doctor `ready=true` 并完成真实 Chromium E2E。
2. 受控会话不读取日常 Chrome Profile，正常结束后删除一次性 Profile；无法确认进程关闭时保留并可恢复清理。
3. 默认 `local-confirmation` 不要求 `identity enroll`；纯只读 E2E 不出现 WebAuthn 页面。
4. 写、注入、隐私和人工最终化在没有明确确认时 fail closed。
5. 报告准确声明 `local-confirmation` 的有限保证，不伪造自然人身份或职责分离。
6. 可选 `webauthn` 模式继续通过原有安全、重放和崩溃恢复测试。
7. 全量 unit/integration、typecheck、build、architecture、package closure 和 Golden 通过；真实系统 Chrome 环境不可用时以显式外部门禁登记，不得用模拟结果冒充。
