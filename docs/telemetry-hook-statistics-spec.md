# Spec：Claude Code / Codex MCP 与 Skill 钩子统计

- 状态：待实现
- 规格版本：1.0.0
- 日期：2026-07-11
- 目标仓库：`mutil-skills`
- 目标读者：实现工程师、测试工程师、功能验收人员

## 1. 目标

实现一套同时支持 Claude Code 与 Codex 的用户级 hook 统计能力，用于回答：

1. 某个 MCP server/tool 被调用了多少次。
2. MCP 调用成功多少次、失败多少次。
3. 某个 Skill 的 `SKILL.md` 被实际加载了多少次。
4. Skill 加载成功多少次、失败多少次。
5. 某个 MCP、Skill 或整个类型在多少个不同回合中被使用。
6. 每次失败的标准错误码、运行时原始错误码和错误信息是什么。

第一期交付事件采集、运行时适配、状态归一化、统计 reducer、会话日志兜底、安装与卸载能力，以及未来上报接口。第一期不得保存事件、上传事件或实现数据看板。

## 2. 已确认假设

1. “Skill 调用”的统计定义是一次将 `SKILL.md` 内容实际返回给模型的加载尝试，不等同于 Codex 内部未公开的语义激活事件。
2. 同一回合的失败重试属于不同调用，分别计数。
3. 同一个 `SKILL.md` 的分段读取属于不同加载调用，分别计数。
4. 用户拒绝、用户取消、超时、会话结束无结果均计入失败。
5. 调用次数和使用回合数是两个独立指标。
6. 第一阶段的事件 sink 是 no-op；统计逻辑通过纯函数和测试数据验证，不依赖持久化服务。
7. 安装产生的 HMAC 密钥属于 hook 配置，不属于统计或日志数据，可以持久化。
8. Hook 以用户级方式默认启用，但项目可以显式退出，用户也可以配置项目忽略列表。

## 3. 非目标

第一期明确不实现：

- 数据库或本地事件文件。
- 真实 HTTP、RPC 或消息队列上传。
- Web 看板、CLI 报表或 CSV/JSON 导出。
- 用户身份识别、组织、角色和权限控制。
- 云端部署与多租户平台。
- 对 Skill 整体业务目标是否完成的判断。
- 对没有文件读取、没有原生 Skill 工具事件、由宿主直接注入内容的 Codex Skill 加载进行猜测。
- 修改 Claude Code 或 Codex 内部实现。

## 4. 术语

| 术语 | 定义 |
|---|---|
| 调用尝试 | 一次独立 MCP 工具执行或一次独立 `SKILL.md` 内容读取 |
| 生命周期事件 | `started`、`completed` 或 `reconciled` 等用于描述调用进展的事件 |
| 最终调用记录 | 按 `callId` 合并生命周期事件后，状态为 `success` 或 `failure` 的记录 |
| 逻辑回合 | 从一次真实用户消息提交开始，到该次 agent 执行最终停止为止；运行时自动 continuation 不创建新的逻辑回合 |
| 原生回合 | 运行时提供的回合标识；一个逻辑回合在特殊 continuation 流程中可能对应多个原生回合 |
| 使用回合数 | 至少包含一次目标调用的不同 `(runtime, sessionId, turnId)` 数量 |
| 实时 hook | 运行时在 `PreToolUse`、`PostToolUse` 等生命周期点调用的命令 hook |
| 日志兜底 | 在回合或会话结束时解析 transcript JSONL，补充漏失事件和无结果状态 |
| 原生错误码 | Claude Code、Codex、操作系统或 MCP server 提供的原始错误标识 |
| 标准错误码 | Telemetry Package 归一化后的稳定错误标识 |

## 5. 功能需求

### FR-001：支持的运行时

系统必须分别实现 Claude Code 和 Codex 适配器。公共统计领域不得依赖任一运行时的原始 payload 结构。

### FR-002：MCP 调用开始

适配器必须在 `PreToolUse` 中识别工具名满足 MCP 命名约定的调用，并产生 `phase = started` 生命周期事件。

事件至少包含：

- `runtime`
- `type = mcp`
- `target = <server>/<tool>`
- `callId`
- `sessionId`
- `turnId`
- `timestamp`
- `projectHash`
- `log.prompt`
- `log.input`
- `source`

### FR-003：MCP 成功

工具结果明确表示正常完成，且不存在明确失败标记时，最终状态必须为 `success`。

成功记录的 `errorCode`、`nativeErrorCode`、`errorMessage` 和 `failureKind` 必须为 `null`。

### FR-004：MCP 失败

以下情况必须最终记录为 `failure`：

- 工具抛出错误。
- 工具超时。
- 标准 MCP 结果包含 `isError: true`。
- 返回对象包含运行时认可的失败状态或错误对象。
- 用户拒绝调用。
- 用户取消调用。
- 回合或会话最终结束时仍无结果。
- 已确认失败但无法归类。

每条失败记录必须包含非空 `errorCode`；可用时还必须保留 `nativeErrorCode` 和 `errorMessage`。

### FR-005：Skill 加载开始

系统必须识别真正以返回文件内容为目的的 `SKILL.md` 读取操作，并为每个读取操作产生独立的 `started` 事件。

应识别：

- Claude Code 原生 `Read` 工具读取 `SKILL.md`。
- Claude Code 原生 `Skill` 工具产生的明确加载事件。
- Claude Code 的直接 Skill slash command 产生 `UserPromptExpansion` started 事件，并由 transcript 确认 Skill 内容已经展开给模型。
- Shell 命令中的内容读取操作，例如 `cat`、`sed`、`head`、`tail`、`awk`、`bat`。
- Transcript 中结构化记录的等价内容读取操作。

不得仅因字符串中出现 `SKILL.md` 就计数。

### FR-006：不构成 Skill 加载的操作

以下操作不得生成 Skill 加载记录：

- `ls`
- `find`
- `test -f`
- `stat`
- `grep`
- `rg`
- 路径补全、目录扫描或文件元数据查询
- 只在 prompt、描述、错误文本或输出文本中提到路径

### FR-007：Skill 目标识别

Skill ID 默认取规范化 `SKILL.md` 路径的直接父目录名。适配器必须支持：

- `.agents/skills/<skill-id>/SKILL.md`
- `.codex/skills/<skill-id>/SKILL.md`
- `.claude/skills/<skill-id>/SKILL.md`
- 插件或缓存目录中的 `skills/<skill-id>/SKILL.md`
- 配置提供的额外 Skill 根目录

路径必须处理空格、shell 引号、`~`、相对路径和符号链接。符号链接可解析时使用 realpath；不可解析时保留词法规范化结果，并不得因此丢弃明确的读取失败。

### FR-008：Skill 成功

读取操作完成，且工具结果明确表明目标 `SKILL.md` 内容已经返回时，最终状态必须为 `success`。

完整读取和分段读取都属于成功加载。每个独立工具操作分别计数。

### FR-009：Skill 失败

以下情况必须记录为 `failure`：

- 文件不存在。
- 无读取权限。
- 读取命令或文件工具失败。
- 读取超时。
- 用户拒绝或取消读取。
- 回合或会话结束仍无结果。
- 已确认失败但无法归类。

### FR-010：一次工具调用读取多个 Skill

当同一个工具调用读取多个 `SKILL.md` 时，每个文件操作必须生成一条独立调用记录。

`callId` 必须从原始 `tool_use_id` 加操作类型和稳定操作序号派生，例如：

```text
<tool_use_id>:skill:<operation-index>
```

如果同一命令将同一路径作为两个独立读取操作执行两次，也必须生成两个不同操作序号并分别计数。

### FR-011：失败重试

失败后重试不得覆盖之前的失败。每个具有独立 `callId` 的尝试分别形成最终记录。

示例：同一回合第一次 Skill 读取失败、第二次成功，必须得到：

```text
usedTurnCount = 1
totalCalls = 2
successCalls = 1
failureCalls = 1
```

### FR-012：回合标识

Codex 适配器必须保留 hook payload 的原生 `turn_id`，并在普通路径中将其作为逻辑 `turnId`。

如果 Stop hook、运行时自动 continuation 或其他非用户行为创建了新的原生 `turn_id`，但没有新的真实用户输入，适配器必须将这些原生回合归并到同一个逻辑 `turnId`。原生值保存在 `nativeTurnId`，不得因归并而丢失。

Claude Code 适配器必须使用 `UserPromptSubmit` 与 transcript 中最近的用户消息边界推导稳定逻辑 `turnId`。同一次用户输入触发的内部工具调用、失败重试、Stop hook 继续执行均必须保持在同一逻辑回合；新的真实用户输入必须产生新的逻辑回合。

当实时事件无法取得稳定逻辑 `turnId` 时，适配器可以暂时使用可重放的候选 ID，但 `Stop`/日志 reconciliation 必须将它归并到最终稳定 ID。不得随机生成不可重放的回合 ID。

### FR-013：生命周期事件

预留的 sink 接收逐事件生命周期数据：

- `started`：调用已观察到，但尚未获得最终结果。
- `completed`：实时 hook 已获得成功或失败结果。
- `reconciled`：日志兜底补充、纠正或收口结果。

第一期不得要求不同 hook 进程共享内存。未来接收端必须能够按 `callId` 幂等归并生命周期事件。

### FR-014：无结果收口

回合或会话最终结束后，只有 `started` 而没有结果的调用必须归为 `failure`：

- MCP 使用 `failureKind = no_result`、`errorCode = MCP_NO_RESULT`。
- Skill 使用 `failureKind = no_result`、`errorCode = SKILL_NO_RESULT`。

### FR-015：实时 hook 与日志去重

同一次调用被实时 hook 和 transcript 同时发现时，只能统计一次。

MCP 使用原始 `tool_use_id` 作为基础幂等键。Skill 使用原始 `tool_use_id`、规范化目标路径和操作序号派生幂等键。`source` 可以由实时来源升级为 `reconciled`，但不得改变调用数量。

### FR-016：Transcript 适配

Claude Code 与 Codex transcript 解析器必须分开实现。每个解析器必须：

- 进行运行时和格式版本识别。
- 对未知字段前向兼容。
- 对缺失必需字段返回结构化解析错误，而不是进程崩溃。
- 使用脱敏 fixture 覆盖已支持格式。
- 不把 transcript 格式视为公共领域模型。

Codex 当前没有可依赖的稳定 `SessionEnd` hook；Codex 必须以 `Stop` 作为主要 reconciliation 触发点。Claude Code 可使用其支持的 `Stop`/`SessionEnd` 生命周期点。

Claude Code 的 `PermissionDenied` 或等价失败事件应直接归一化为失败。运行时没有提供最终权限结果的情况，包括 Codex 的用户拒绝或取消，必须由 transcript 在 `Stop` 时归一化为 `*_REJECTED` 或 `*_CANCELLED`；不得退化为 `*_NO_RESULT`，除非 transcript 也无法确定原因。

### FR-017：统一错误码

MCP 标准错误码：

| 错误码 | 条件 |
|---|---|
| `MCP_REJECTED` | 用户拒绝 |
| `MCP_CANCELLED` | 用户取消 |
| `MCP_TIMEOUT` | 调用超时 |
| `MCP_ERROR` | 工具抛出错误 |
| `MCP_RETURNED_FAILURE` | 返回结果明确表示失败 |
| `MCP_NO_RESULT` | 最终无结果 |
| `MCP_UNKNOWN_ERROR` | 已知失败但无法归类 |

Skill 标准错误码：

| 错误码 | 条件 |
|---|---|
| `SKILL_NOT_FOUND` | `SKILL.md` 不存在 |
| `SKILL_PERMISSION_DENIED` | 无读取权限 |
| `SKILL_READ_FAILED` | 读取操作失败 |
| `SKILL_TIMEOUT` | 读取超时 |
| `SKILL_REJECTED` | 用户拒绝 |
| `SKILL_CANCELLED` | 用户取消 |
| `SKILL_NO_RESULT` | 最终无结果 |
| `SKILL_UNKNOWN_ERROR` | 已知失败但无法归类 |

### FR-018：原始错误信息

标准化过程不得覆盖原始错误信息：

- `nativeErrorCode` 保存原始错误码或操作系统错误名。
- `errorMessage` 保存原始错误说明；如果只存在结构化错误对象，应生成稳定字符串表示，同时在 `log.output` 保留原始结构。
- 成功记录的错误字段必须为 `null`。

### FR-019：项目哈希

`install-hooks` 首次安装必须生成至少 256 bit 的随机本机密钥，并以仅当前用户可读的权限保存。

项目标识必须按下式计算：

```text
projectHash = HMAC-SHA256(localSecret, canonicalWorkingDirectory)
```

不得在事件的结构化统计字段中保留原始工作目录。由于用户已要求保留完整日志，原始 hook payload 如果包含目录，可存在于 `log`，但第一期 no-op sink 不得落盘或传输。

### FR-020：完整日志字段

统一事件必须允许保留：

- prompt
- 工具输入或读取命令
- 工具输出
- 错误对象或错误文本

第一期这些字段仅存在于当前进程内存中的事件对象；默认 sink 不得写磁盘、打印到 stdout/stderr 或访问网络。

### FR-021：统计 reducer

统计 reducer 必须接受任意顺序的生命周期事件，并按 `callId` 幂等归并成最终调用记录。

对完成 reconciliation 的调用集合 `C`：

```text
successCalls = count(C where status = success)
failureCalls = count(C where status = failure)
totalCalls = count(C)
totalCalls = successCalls + failureCalls
usedTurnCount = distinct count(runtime, sessionId, turnId)
successRate = successCalls / totalCalls * 100%
failureRate = failureCalls / totalCalls * 100%
averageCallsPerUsedTurn = totalCalls / usedTurnCount
```

当分母为 0 时，对应比率必须返回 `null`，展示层应显示 `N/A`，不得返回 `NaN` 或无穷大。

### FR-022：统计分组

Reducer 至少支持按以下维度分组：

- `runtime`
- `type`
- `target`
- `projectHash`
- 时间范围

按具体目标分组时，使用回合数只计算使用过该目标的回合。按整个类型分组时，同一回合使用多个不同目标，只计一个类型使用回合。

时间范围必须按 `TelemetryCall.startedAt` 筛选。跨越时间范围边界的调用归属于开始时间所在范围，不得按完成时间重复归类。

### FR-023：TelemetrySink

公共接口必须允许未来替换真实上报实现：

```ts
export interface TelemetrySink {
  send(event: TelemetryLifecycleEvent): Promise<void>
}

export class NoopTelemetrySink implements TelemetrySink {
  async send(_event: TelemetryLifecycleEvent): Promise<void> {}
}
```

第一期 hook entrypoint 必须默认构造 `NoopTelemetrySink`。不得存在隐式网络 fallback。

### FR-024：安装

必须提供显式 `install-hooks` 命令：

- 支持安装 Claude Code 用户级 hook。
- 支持安装 Codex 用户级 hook。
- 安装前读取并保留用户已有配置。
- 只添加本项目拥有且可识别的配置项。
- 重复执行必须幂等。
- 不得在包安装、测试、构建或导入模块时自动修改用户配置。
- Codex 非托管 command hook 需要用户进行运行时信任确认；安装说明必须明确提示。

### FR-025：卸载

必须提供显式 `uninstall-hooks` 命令，只删除本项目拥有的 hook 配置和本机 HMAC 密钥，不得删除或格式破坏用户的其他配置。

### FR-026：Hook 失败隔离

统计 hook 自身解析失败、sink 失败或内部异常不得阻断被统计的 MCP/Skill 调用。Hook 必须在允许原操作继续的退出码下结束，并将内部错误限制为安全、无敏感 payload 的诊断信息。

### FR-027：默认覆盖与项目退出

安装后的用户级 hook 必须默认覆盖该用户运行 Claude Code 或 Codex 的所有项目。

系统必须同时支持：

- 项目级显式关闭统计。
- 用户级项目忽略列表。

退出判断必须发生在读取或解析 prompt、工具参数、工具结果和 transcript 之前。被排除项目不得产生生命周期事件，不得读取 transcript，也不得调用 sink。

项目级退出配置固定为项目根目录的 `.mutil-skills/telemetry.json`：

```json
{
  "enabled": false
}
```

用户级统一配置固定为 `~/.mutil-skills/telemetry.json`，忽略列表字段为 `excludedProjects: string[]`，第一期每项是规范化项目绝对路径，不支持 glob。HMAC 密钥固定存储于 `~/.mutil-skills/telemetry.key`。同一套判断规则必须同时适用于 Claude Code 和 Codex。

## 6. 数据模型

### 6.1 生命周期事件

```ts
export type Runtime = 'claude-code' | 'codex'
export type TargetType = 'mcp' | 'skill'
export type LifecyclePhase = 'started' | 'completed' | 'reconciled'
export type FinalStatus = 'success' | 'failure'
export type TelemetrySource =
  | 'pre_tool_use'
  | 'post_tool_use'
  | 'post_tool_use_failure'
  | 'permission_denied'
  | 'user_prompt_expansion'
  | 'stop_transcript'
  | 'session_end_transcript'
  | 'reconciled'
export type FailureKind =
  | 'error'
  | 'timeout'
  | 'returned_failure'
  | 'rejected'
  | 'cancelled'
  | 'not_found'
  | 'permission_denied'
  | 'read_failed'
  | 'no_result'
  | 'unknown_error'

export interface TelemetryLifecycleEvent {
  schemaVersion: 1
  runtime: Runtime
  type: TargetType
  target: string
  callId: string
  sessionId: string
  turnId: string
  nativeTurnId: string | null
  phase: LifecyclePhase
  status: FinalStatus | null
  failureKind: FailureKind | null
  errorCode: string | null
  nativeErrorCode: string | null
  errorMessage: string | null
  timestamp: string
  projectHash: string
  source: TelemetrySource
  log: {
    prompt: unknown
    input: unknown
    output: unknown
    error: unknown
  }
}
```

约束：

- `phase = started` 时，`status` 和所有错误字段必须为 `null`。
- `status = success` 时，所有错误字段必须为 `null`。
- `status = failure` 时，`failureKind` 和 `errorCode` 必须非空。
- `timestamp` 必须可被严格解析为 UTC ISO 8601。
- 所有事件必须携带 `schemaVersion`，未来协议演进不得静默改变既有字段语义。
- `turnId` 是统计使用的逻辑回合；`nativeTurnId` 只用于审计和运行时关联。
- `log` 中当前 hook 不可取得的字段必须为 `null`，不得编造；reconciliation 可以补齐字段。

### 6.2 最终调用记录

```ts
export interface TelemetryCall {
  runtime: Runtime
  type: TargetType
  target: string
  callId: string
  sessionId: string
  turnId: string
  nativeTurnIds: string[]
  status: FinalStatus
  failureKind: FailureKind | null
  errorCode: string | null
  nativeErrorCode: string | null
  errorMessage: string | null
  startedAt: string
  completedAt: string
  projectHash: string
  source: TelemetrySource
  log: TelemetryLifecycleEvent['log']
}
```

### 6.3 汇总结果

```ts
export interface TelemetrySummary {
  totalCalls: number
  successCalls: number
  failureCalls: number
  usedTurnCount: number
  successRate: number | null
  failureRate: number | null
  averageCallsPerUsedTurn: number | null
}
```

## 7. 运行时采集矩阵

| 行为 | Claude Code | Codex |
|---|---|---|
| MCP 开始 | `PreToolUse` | `PreToolUse` |
| MCP 成功 | `PostToolUse` | `PostToolUse.tool_response` |
| MCP 失败 | `PostToolUseFailure` | `PostToolUse.tool_response` 或 transcript |
| 用户拒绝或取消 | `PermissionDenied`、失败事件或 transcript | transcript 在 `Stop` 时收口 |
| Skill 原生加载 | `Skill` 工具事件 | 无原生 hook |
| Skill 直接命令 | `UserPromptExpansion` + transcript | 无结构化 hook；只统计实际文件读取 |
| Skill 文件读取 | `Read`/`Bash` 工具事件 | 支持范围内的 `Bash` hook |
| 分段读取 | 每个工具调用分别计数 | 每个工具调用分别计数 |
| 回合 ID | 从用户消息和 transcript 推导 | 原生 `turn_id` |
| 日志兜底 | `Stop`/`SessionEnd` | `Stop` |
| 无结果收口 | 失败 | 失败 |

已知限制：Codex 对新式 `unified_exec` 的 hook 拦截不完整，且 transcript 不是稳定接口；宿主直接注入 Skill 内容而不产生可观察事件时无法统计。

## 8. 项目结构

建议新增独立 workspace 包，避免将 MCP/Skill 业务语义放入业务中立的 `@mutil-skills/core`：

```text
packages/telemetry/
├── package.json
├── tsconfig.json
├── src/
│   ├── index.ts
│   ├── domain/
│   │   ├── events.ts
│   │   ├── errors.ts
│   │   ├── reducer.ts
│   │   └── summary.ts
│   ├── adapters/
│   │   ├── claude-code.ts
│   │   └── codex.ts
│   ├── detectors/
│   │   ├── mcp.ts
│   │   ├── skill-read.ts
│   │   └── shell-read.ts
│   ├── transcripts/
│   │   ├── claude-code.ts
│   │   └── codex.ts
│   ├── project-id/
│   │   └── hmac.ts
│   ├── config/
│   │   ├── project-opt-out.ts
│   │   └── ignored-projects.ts
│   ├── sinks/
│   │   ├── sink.ts
│   │   └── noop.ts
│   └── install/
│       ├── claude-code.ts
│       └── codex.ts
└── test/
    ├── fixtures/
    └── *.test.ts

packages/cli/src/bin/
├── telemetry-hook.ts
├── install-hooks.ts
└── uninstall-hooks.ts
```

依赖方向：

```text
cli -> telemetry
telemetry -> core（仅允许复用业务中立技术原语）
core -X-> telemetry
skills -X-> telemetry runtime
```

## 9. 技术栈与依赖原则

- TypeScript ESM，与现有仓库一致。
- Zod 可用于运行时 payload 和事件 schema 校验。
- Node.js 内置 `crypto` 用于 HMAC 和随机密钥。
- Shell 命令解析优先使用已有能力；如果必须新增第三方 parser，需要单独确认。
- 第一阶段不得加入数据库、HTTP client 或 telemetry vendor SDK。

## 10. 命令

现有仓库级验证命令：

```bash
npm test
npm run typecheck
npm run build
npm run lint:architecture
```

计划新增的可执行命令：

```bash
install-hooks --runtime claude-code
install-hooks --runtime codex
install-hooks --runtime all

uninstall-hooks --runtime claude-code
uninstall-hooks --runtime codex
uninstall-hooks --runtime all

telemetry-hook --runtime claude-code --event pre-tool-use
telemetry-hook --runtime claude-code --event post-tool-use
telemetry-hook --runtime claude-code --event post-tool-use-failure
telemetry-hook --runtime claude-code --event permission-denied
telemetry-hook --runtime claude-code --event user-prompt-expansion
telemetry-hook --runtime claude-code --event stop
telemetry-hook --runtime claude-code --event session-end

telemetry-hook --runtime codex --event pre-tool-use
telemetry-hook --runtime codex --event post-tool-use
telemetry-hook --runtime codex --event stop
```

Hook payload 必须从 stdin 读取；统计结果不得打印到 stdout，以免改变运行时 hook 语义。

## 11. 代码风格

适配器只负责将不可信运行时 payload 转为领域事件；状态规则必须位于可测试的纯函数中。

```ts
export function classifySkillReadResult(
  result: SkillReadResult,
): FinalOutcome {
  if (result.permissionDenied) {
    return failure('permission_denied', 'SKILL_PERMISSION_DENIED', result)
  }

  if (result.contentReturned) {
    return success()
  }

  return failure('read_failed', 'SKILL_READ_FAILED', result)
}
```

约定：

- 领域类型使用明确 union，不使用宽泛字符串。
- 解析不可信输入时返回结构化结果，不使用未经校验的类型断言。
- 错误码集中定义，不散落字符串字面量。
- Reducer 必须是确定性纯函数。
- 敏感日志不得出现在异常消息、测试快照或安装日志中。

## 12. 测试策略

### 12.1 单元测试

必须覆盖：

- MCP 名称解析和 target 归一化。
- 每个标准错误码映射。
- Skill 路径识别和 Skill ID 提取。
- Shell 内容读取识别正例与反例。
- Lifecycle event 合并顺序变化。
- 同一 `callId` 重复输入的幂等性。
- 回合 distinct count。
- 0 分母返回 `null`。
- HMAC 稳定性和不同密钥隔离。
- 逻辑回合与原生回合归并。
- 时间范围按 `startedAt` 筛选。

### 12.2 Fixture 测试

必须提供脱敏 fixture：

- Claude Code MCP 成功。
- Claude Code MCP 工具失败。
- Claude Code 用户拒绝和取消。
- Claude Code `PermissionDenied` 归一化。
- Claude Code 直接 `/skill-name` 由 `UserPromptExpansion` 开始并由 transcript 确认。
- Codex MCP 标准成功。
- Codex MCP `isError: true`。
- Codex MCP 无法即时分类、由 transcript 收口。
- Skill `Read` 成功。
- Skill 不存在、无权限、超时。
- Skill 失败后重试成功。
- Skill 分段读取。
- 一个命令读取多个 Skill。
- `ls`、`find`、`test -f`、`stat`、`grep`、`rg` 不计数。
- 实时 hook 与 JSONL 重复事件去重。
- 会话结束无结果转为失败。
- 同一目标在一个回合多次调用，`usedTurnCount = 1`。
- 同一目标跨多个回合调用，`usedTurnCount` 正确增加。
- 内部 continuation 产生新原生回合时，逻辑 `usedTurnCount` 不增加。
- 新的真实用户输入产生新的逻辑回合。

### 12.3 安装测试

必须只使用临时 HOME/CODEX_HOME/CLAUDE_CONFIG_DIR：

- 空配置安装。
- 合并已有 hook 配置。
- 重复安装幂等。
- 卸载仅删除自有条目。
- 畸形配置时安全失败且不覆盖源文件。
- 安装生成的密钥文件权限符合当前平台安全要求。
- 测试不得修改真实 `~/.codex` 或 `~/.claude`。
- 项目级退出和用户级忽略列表在解析敏感 payload 前生效。
- 项目配置 `.mutil-skills/telemetry.json` 与用户配置 `~/.mutil-skills/telemetry.json` 的固定协议。

### 12.4 回归验证

完成实现后必须运行：

```bash
npm test
npm run typecheck
npm run build
npm run lint:architecture
```

## 13. 验收场景

### AC-001：MCP 单次成功

Given 一个回合中 MCP 调用开始并正常返回
When reducer 完成 reconciliation
Then `totalCalls = 1`、`successCalls = 1`、`failureCalls = 0`、`usedTurnCount = 1`。

### AC-002：MCP 失败后成功

Given 同一回合第一次 MCP 调用超时、第二次成功
Then `totalCalls = 2`、`successCalls = 1`、`failureCalls = 1`、`usedTurnCount = 1`，失败记录为 `MCP_TIMEOUT`。

### AC-003：MCP 被拒绝

Given 用户拒绝 MCP 调用
Then 该调用状态为 `failure`，`failureKind = rejected`，`errorCode = MCP_REJECTED`。

### AC-004：MCP 无结果

Given MCP 已产生 started，但回合结束仍无结果
Then 该调用状态为 `failure`，`failureKind = no_result`，`errorCode = MCP_NO_RESULT`。

### AC-005：Skill 单次成功

Given 内容读取操作成功返回一个 `SKILL.md` 的内容
Then 产生一条 Skill 成功记录。

### AC-006：Skill 失败后成功

Given 同一回合第一次 Skill 读取返回 EACCES、第二次成功
Then `totalCalls = 2`、`successCalls = 1`、`failureCalls = 1`、`usedTurnCount = 1`，失败记录同时保留 `SKILL_PERMISSION_DENIED` 和 `EACCES`。

### AC-007：Skill 分段读取

Given 同一回合分别成功读取 `SKILL.md` 的两个行区间
Then `totalCalls = 2`、`successCalls = 2`、`usedTurnCount = 1`。

### AC-008：非加载操作

Given 只执行 `test -f`、`stat`、`grep` 或 `rg`
Then 不生成 Skill 调用记录。

### AC-009：跨回合统计

Given 一个目标在三个不同回合中共有四次调用
Then `totalCalls = 4`、`usedTurnCount = 3`。

### AC-010：实时和日志去重

Given 同一个 `tool_use_id` 同时出现在 PostToolUse 和 transcript
Then 最终只存在一条调用记录。

### AC-011：默认不保存、不上传

Given 使用默认配置执行任意 hook fixture
Then 不产生事件文件、不访问网络、不向 stdout 输出日志数据。

### AC-012：配置安全

Given 用户已有其他 hook
When 安装再卸载本项目 hook
Then 用户原有 hook 在内容和顺序语义上保持不变。

### AC-013：项目退出

Given 项目已显式退出，或项目匹配用户级忽略列表
When 任意 Claude Code 或 Codex hook 被触发
Then 不解析 prompt、参数、结果或 transcript，不产生事件，也不调用 sink。

### AC-014：内部 continuation 不增加回合

Given 同一次真实用户输入触发运行时内部 continuation，并出现两个原生回合 ID
When 统计同一目标的使用回合数
Then 两个原生回合归入同一个逻辑 `turnId`，`usedTurnCount = 1`。

## 14. 完成定义

只有同时满足以下条件，功能才视为完成：

1. FR-001 至 FR-027 均有对应实现和自动化测试。
2. AC-001 至 AC-014 全部通过。
3. Claude Code 与 Codex 的脱敏 fixture 均可转换为统一事件。
4. 每种失败都有非空标准错误码，原始错误码可用时不丢失。
5. 调用次数和 distinct 使用回合数符合公式。
6. 默认 sink 经测试证明不写磁盘、不发网络、不输出敏感数据。
7. 安装和卸载不破坏已有配置。
8. 四条仓库级验证命令全部通过。
9. 使用者说明与本 Spec 的统计口径一致。
10. 已知限制在 README 或使用者说明中可见。

## 15. 边界规则

### Always do

- 校验所有运行时输入。
- 失败记录保留标准错误码和原始错误信息。
- 使用 `callId` 幂等处理重复事件。
- 将 transcript parser 与领域逻辑隔离。
- 使用临时目录测试安装逻辑。
- 在读取敏感 payload 前应用项目退出规则。
- 在运行时版本变化时用 fixture 验证兼容性。

### Ask first

- 新增第三方 shell parser。
- 修改统一事件 schema 的既有字段语义。
- 实现真实网络 sink 或持久化。
- 增加用户身份或项目原始路径字段。
- 修改架构依赖规则。

### Never do

- 默认上传或保存 prompt、工具参数、返回值、文件内容。
- 把拒绝、取消或无结果排除在失败统计之外。
- 将同一 `callId` 的 hook 和 JSONL 记录计算两次。
- 将 `grep`、`rg`、`stat` 等操作当成 Skill 加载。
- 以随机、不可重放 ID 代替最终回合标识。
- 测试时写入用户真实 Claude Code 或 Codex 配置。
- 因统计 hook 失败而阻断用户原始工具调用。
- 对已退出项目解析 prompt、参数、结果或 transcript。

## 16. 风险与缓解

| 风险 | 影响 | 缓解 |
|---|---|---|
| Codex `unified_exec` hook 覆盖不完整 | Skill 读取漏计 | Stop 时解析 transcript；保留明确已知限制 |
| Transcript 格式变化 | 兜底解析失败 | 运行时独立适配器、版本识别、fixture 回归 |
| MCP server 非标准表达业务失败 | 成功/失败误判 | 标准字段优先、原始响应保留、未知失败码、日志兜底 |
| Shell 命令语义复杂 | Skill 读取漏计或误计 | 结构化解析、明确 allowlist、正反 fixture；新增 parser 需确认 |
| Hook 多进程且第一期无状态 | 无法本机实时归并 | 生命周期事件 + 稳定 callId；reducer 纯函数；未来接收端幂等归并 |
| 运行时 continuation 产生新原生回合 | 使用回合数虚高 | 保存原生回合 ID，并按真实用户输入边界归并逻辑回合 |
| 敏感日志进入诊断输出 | 数据泄露 | Noop sink、禁止 stdout/stderr 打印 payload、测试脱敏 fixture |
| 宿主直接注入 Skill 内容 | 无可观察读取事件 | 不猜测；文档声明不支持；未来可选 App Server 集成 |

## 17. 可追溯性矩阵

| 目标 | 需求 | 验收 |
|---|---|---|
| MCP 调用及状态 | FR-002–FR-004、FR-013–FR-018 | AC-001–AC-004、AC-010 |
| Skill 加载及状态 | FR-005–FR-011、FR-014–FR-018 | AC-005–AC-008、AC-010 |
| 回合统计 | FR-012、FR-021、FR-022 | AC-002、AC-006、AC-007、AC-009 |
| 隐私与项目标识 | FR-019、FR-020、FR-023 | AC-011 |
| 安装、卸载与项目退出 | FR-024–FR-027 | AC-012–AC-014 |

## 18. 参考资料

- [Claude Code Hooks reference](https://code.claude.com/docs/en/hooks)
- [Codex Hooks](https://learn.chatgpt.com/docs/hooks)
- [Codex App Server](https://learn.chatgpt.com/docs/app-server)
- [Codex Build skills](https://learn.chatgpt.com/docs/build-skills)

## 19. 未决问题

当前无阻塞实现的未决产品问题。若运行时 fixture 显示官方 payload 与本 Spec 不一致，必须先更新本 Spec 并由需求方确认，再修改实现。
