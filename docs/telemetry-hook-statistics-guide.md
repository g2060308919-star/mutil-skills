# MCP 与 Skill 钩子统计说明

## 1. 这套钩子统计什么

这套钩子面向 Claude Code 和 Codex，统计两类可观察行为：

1. MCP 工具调用：某个 MCP server 的某个工具被调用了多少次，多少次成功，多少次失败，出现在哪些回合。
2. Skill 加载：某个 `SKILL.md` 被实际加载了多少次，多少次成功，多少次失败，出现在哪些回合。

第一期只完成事件采集、标准化、状态判断和统计计算。它不会保存数据，不会上传数据，也不提供数据看板。代码只预留 `TelemetrySink` 接口，未来接入服务端时替换默认的 no-op 实现即可。

## 2. 核心概念

### 2.1 一次调用

MCP 的一次调用，是一次独立的 MCP 工具执行尝试。

Skill 的一次调用，是一次将 `SKILL.md` 内容返回给模型的独立加载尝试。每次尝试分别计数：同一回合内失败后重试，算两次；同一文件分两段读取，也算两次。

以下行为不算 Skill 加载，因为它们没有把 Skill 指令内容返回给模型：

- `ls`、`find`：只发现路径。
- `test -f`、`stat`：只检查文件或元数据。
- `grep`、`rg`：只搜索匹配片段。
- 仅在 prompt、参数或输出中提到 `SKILL.md` 路径，但没有真正执行读取。

### 2.2 一个回合

一个回合从用户提交一条消息开始，到该次 agent 执行最终停止为止。模型在内部调用工具、读取 Skill、失败后重试，都仍属于同一个回合。只有用户再次提交新消息，才进入下一个回合。

统计使用回合数时，同一个目标在同一回合无论调用多少次，都只贡献一个回合；调用次数仍按每次尝试分别计算。

### 2.3 成功与失败

所有已经开始的调用最终只能归为成功或失败。拒绝、取消和会话结束仍无结果也属于失败，但会保留不同的失败原因和错误码。

| 类型 | 成功 | 失败 |
|---|---|---|
| MCP | 工具正常返回，且没有明确的 MCP 失败标志 | 工具报错、超时、返回失败、用户拒绝、用户取消，或会话结束仍无结果 |
| Skill | `SKILL.md` 内容成功返回给模型 | 文件不存在、无权限、读取失败、超时、用户拒绝、用户取消，或会话结束仍无结果 |

## 3. 采集哪些数据

每次调用形成一条标准化调用记录。失败记录必须包含平台统一错误码；如果运行时或 MCP server 提供了原始错误码，也同时保留。

```json
{
  "runtime": "codex",
  "type": "skill",
  "target": "test-driven-development",
  "callId": "tool_use_xxx:skill:0",
  "sessionId": "session_xxx",
  "turnId": "turn_xxx",
  "nativeTurnId": "native_turn_xxx",
  "status": "failure",
  "failureKind": "permission_denied",
  "errorCode": "SKILL_PERMISSION_DENIED",
  "nativeErrorCode": "EACCES",
  "errorMessage": "Permission denied",
  "timestamp": "2026-07-11T10:00:00Z",
  "projectHash": "...",
  "source": "post_tool_use",
  "log": {
    "prompt": "...",
    "input": {},
    "output": null,
    "error": {
      "code": "EACCES",
      "message": "Permission denied"
    }
  }
}
```

字段含义：

| 字段 | 含义 |
|---|---|
| `runtime` | `claude-code` 或 `codex` |
| `type` | `mcp` 或 `skill` |
| `target` | MCP 使用 `server/tool`；Skill 使用 Skill ID |
| `callId` | 单次调用的稳定标识，用于合并开始和结果事件、避免重复统计 |
| `sessionId` | 会话标识 |
| `turnId` | 回合标识 |
| `nativeTurnId` | 运行时原生回合标识；运行时未提供时为 `null` |
| `status` | 最终值为 `success` 或 `failure` |
| `failureKind` | `error`、`timeout`、`rejected`、`cancelled`、`no_result` 等失败类别 |
| `errorCode` | 平台统一错误码；成功时为 `null` |
| `nativeErrorCode` | 运行时或 MCP server 原始错误码；没有时为 `null` |
| `errorMessage` | 原始或规范化后的错误说明；成功时为 `null` |
| `timestamp` | 事件发生时间，使用 UTC ISO 8601 |
| `projectHash` | 工作目录的稳定不可逆标识 |
| `source` | 具体采集来源，例如 `pre_tool_use`、`post_tool_use`、`stop_transcript` |
| `log` | prompt、工具输入、工具输出等完整日志载荷 |

第一期 `TelemetrySink` 是 no-op，因此这些字段只在内存中的事件对象里存在，不会写入磁盘或发送到网络。

## 4. 数据怎么采集

### 4.1 MCP 采集

每次 MCP 调用由生命周期事件组成：

```text
PreToolUse
  -> 记录 started，保存 tool_name、tool_input、tool_use_id、session 和 turn

PostToolUse / PostToolUseFailure
  -> 使用同一 callId 记录 success 或 failure

Stop / 运行时支持的 SessionEnd
  -> 从会话日志补漏
  -> 仍只有 started 而没有结果的调用，记录 failure + *_NO_RESULT
```

Claude Code 提供独立的 `PostToolUse` 和 `PostToolUseFailure`，可以直接区分成功与失败。

Codex 使用 `PostToolUse` 中的 `tool_response` 判断结果。标准 MCP `isError: true`、明确的错误对象或失败状态均判为失败。如果实时 hook 没有提供足够证据，则在回合结束时由会话日志兜底；最终仍无结果时判为失败，错误码为 `MCP_NO_RESULT`。

### 4.2 Skill 采集

Skill 不是 Codex 原生 hook 中独立的工具事件，因此统计以“实际读取 `SKILL.md`”为证据。

可计数的读取包括：

- Claude Code 的文件读取工具返回了 `SKILL.md` 内容。
- Claude Code 原生 `Skill` 工具明确完成了一次 Skill 加载。
- Claude Code 的直接 `/skill-name` 触发 `UserPromptExpansion`，并由 transcript 确认 Skill 内容已经展开给模型。
- Codex 或 Claude Code 执行 `cat`、`sed`、`head`、`tail`、`awk` 等内容读取命令，并返回了目标 `SKILL.md` 内容。
- 会话 JSONL 明确记录了上述读取调用及其结果。

一个工具调用读取多个 `SKILL.md` 时，每个文件操作分别形成一个 `callId`。同一次工具调用被实时 hook 和 JSONL 同时发现时，使用原始 `tool_use_id`、目标路径和操作序号进行幂等去重。

Codex 对部分新式执行路径的 hook 覆盖并不完整，所以 `Stop` 时解析会话 JSONL 是必要兜底。JSONL 格式不是稳定公开接口，解析器需要按运行时版本隔离和测试。如果宿主直接注入 Skill 内容且完全没有文件读取或 Skill 加载事件，本方案无法观察到该次加载。

### 4.3 项目标识

安装 hook 时生成一份本机随机密钥。每次事件使用下面的方式计算项目标识：

```text
projectHash = HMAC-SHA256(localSecret, canonicalWorkingDirectory)
```

这样同一台机器上的同一项目会得到稳定标识，同时不能通过常见目录路径直接反查。该密钥是配置，不是统计数据；第一期除此之外不持久化任何事件或日志。

Hook 以用户级方式默认启用，覆盖该用户运行 Claude Code 或 Codex 的所有项目。敏感项目可以通过项目根目录下的 `.mutil-skills/telemetry.json` 显式关闭：

```json
{
  "enabled": false
}
```

也可以把规范化项目绝对路径加入 `~/.mutil-skills/telemetry.json` 的 `excludedProjects`。被排除的项目必须在读取 prompt、工具参数、结果或 transcript 之前停止采集。本机 HMAC 密钥保存在 `~/.mutil-skills/telemetry.key`，安装程序必须限制为仅当前用户可读。

## 5. 采集后怎么计算

先按 `callId` 合并生命周期事件。`started` 本身不是一条额外调用，最终结果覆盖同一 `callId` 的临时状态。回合结束时，任何尚未完成的调用转为失败。

对指定时间范围和指定目标，令：

- `C`：完成回合收口和 `callId` 去重后的调用集合。
- `S`：`C` 中 `status = success` 的调用集合。
- `F`：`C` 中 `status = failure` 的调用集合。
- `T`：`C` 中不同 `(runtime, sessionId, turnId)` 的集合。

计算公式：

```text
总调用次数       = |C|
成功次数         = |S|
失败次数         = |F|
使用回合数       = |T|
总调用次数       = 成功次数 + 失败次数
成功率           = 成功次数 / 总调用次数 * 100%
失败率           = 失败次数 / 总调用次数 * 100%
平均每回合调用数 = 总调用次数 / 使用回合数
```

当总调用次数为 0 时，成功率和失败率显示为 `N/A`；当使用回合数为 0 时，平均每回合调用数显示为 `N/A`。

汇总某个具体目标时，`T` 只包含使用了该目标的回合。汇总整个 MCP 或 Skill 类型时，同一回合即使使用了多个不同目标，也只计一个类型使用回合。

时间范围使用调用的开始时间筛选。即使调用在筛选范围结束后才完成，它仍归属于开始时所在的时间范围。

## 6. 一眼能看懂的计算示例

### 示例 1：一次 MCP 成功

一个回合中调用 `github/create_issue` 一次并正常返回：

```text
使用回合数：1
总调用次数：1
成功次数：1
失败次数：0
成功率：100%
```

### 示例 2：同一回合 MCP 失败后重试成功

第一次调用超时，第二次成功：

```text
使用回合数：1
总调用次数：2
成功次数：1
失败次数：1
成功率：50%
```

第一次失败保留 `errorCode = MCP_TIMEOUT`。

### 示例 3：用户拒绝 MCP 调用

调用已经产生，但用户在权限确认中拒绝：

```text
使用回合数：1
总调用次数：1
成功次数：0
失败次数：1
```

失败记录使用 `failureKind = rejected`、`errorCode = MCP_REJECTED`。

### 示例 4：会话中断，MCP 没有返回结果

`PreToolUse` 已记录开始，但会话结束时仍没有结果：

```text
使用回合数：1
总调用次数：1
成功次数：0
失败次数：1
```

失败记录使用 `failureKind = no_result`、`errorCode = MCP_NO_RESULT`。

### 示例 5：Skill 一次加载成功

工具成功返回 `test-driven-development/SKILL.md` 内容：

```text
使用回合数：1
总加载次数：1
成功次数：1
失败次数：0
```

### 示例 6：同一回合 Skill 加载失败后重试成功

第一次读取因无权限失败，第二次读取成功：

```text
使用回合数：1
总加载次数：2
成功次数：1
失败次数：1
```

第一次失败保留 `errorCode = SKILL_PERMISSION_DENIED` 和原始错误码 `EACCES`。

### 示例 7：Skill 分两段读取

同一回合执行两次读取：第一次读取第 1–200 行，第二次读取第 201–400 行，两次都成功：

```text
使用回合数：1
总加载次数：2
成功次数：2
失败次数：0
```

### 示例 8：只检查 Skill 文件，不加载内容

同一回合执行 `test -f`、`stat` 和 `rg`，但没有任何操作把 `SKILL.md` 内容返回给模型：

```text
使用回合数：0
总加载次数：0
成功次数：0
失败次数：0
```

### 示例 9：同一个 Skill 跨三个回合使用

- 回合 1：加载成功一次。
- 回合 2：先失败、后成功。
- 回合 3：加载成功一次。

```text
使用回合数：3
总加载次数：4
成功次数：3
失败次数：1
成功率：75%
平均每回合加载数：4 / 3 = 1.33
```

### 示例 10：一个回合使用两个不同 MCP

同一回合分别成功调用 `github/get_issue` 和 `slack/search`：

```text
整个 MCP 类型：使用回合数 1，总调用次数 2
github/get_issue：使用回合数 1，总调用次数 1
slack/search：使用回合数 1，总调用次数 1
```

## 7. 标准错误码

| MCP 错误码 | 含义 |
|---|---|
| `MCP_REJECTED` | 用户拒绝执行 |
| `MCP_CANCELLED` | 用户取消执行 |
| `MCP_TIMEOUT` | 工具调用超时 |
| `MCP_ERROR` | 工具执行抛出错误 |
| `MCP_RETURNED_FAILURE` | MCP 正常返回响应，但响应明确表示失败 |
| `MCP_NO_RESULT` | 会话结束仍没有结果 |
| `MCP_UNKNOWN_ERROR` | 已确认失败，但无法归入其他错误码 |

| Skill 错误码 | 含义 |
|---|---|
| `SKILL_NOT_FOUND` | `SKILL.md` 不存在 |
| `SKILL_PERMISSION_DENIED` | 无权限读取 |
| `SKILL_READ_FAILED` | 读取操作失败 |
| `SKILL_TIMEOUT` | 读取操作超时 |
| `SKILL_REJECTED` | 用户拒绝读取 |
| `SKILL_CANCELLED` | 用户取消读取 |
| `SKILL_NO_RESULT` | 会话结束仍没有结果 |
| `SKILL_UNKNOWN_ERROR` | 已确认失败，但无法归入其他错误码 |

## 8. 已知边界

1. MCP 是原生工具调用，hook 可以直接观察；Skill 在 Codex 中没有独立的 `SkillUse` hook，主要依赖实际文件读取证据。
2. Codex 的 `PostToolUse` 提供任意 JSON 形式的 `tool_response`，不是所有 MCP server 都以同一种结构表达业务失败；适配器会优先识别标准错误字段，无法确认时由日志兜底。
3. Codex transcript 不是稳定接口，运行时升级可能需要更新 JSONL 适配器。
4. 宿主直接注入 Skill 内容、且不产生可观察加载事件时无法统计。
5. 第一阶段不保存和上传数据，因此真实跨进程汇总将在未来接入上报服务后完成；第一期通过纯函数和 fixtures 验证统计逻辑。
6. 用户级 hook 默认覆盖所有项目，但项目可以在任何敏感数据被解析前显式退出。
7. 部分 Codex 版本的用户级 `PostToolUse` 或 `unified_exec` 覆盖仍不完整；实现会在 `Stop` 解析 transcript 兜底，但宿主完全不产生 hook 或 transcript 证据时仍无法统计。
8. Codex 0.144.1 的 `codex exec --ephemeral` 运行面可能不执行用户级 `PreToolUse`/`PostToolUse` command hook；需要在交互式 Codex 运行面确认，不能把 `codex exec` 的无事件结果误判为 Skill 未加载。

## 9. 临时验收模式

默认 hook 永远使用 `NoopTelemetrySink`，不会产生事件文件。需要验证真实运行时触发时，可以显式设置 `MUTIL_TELEMETRY_VERIFICATION_OUTPUT`，并且必须把路径放在系统临时目录下的 `mutil-skills-telemetry-verification` 目录中。该模式只用于一次性验收：读取 JSONL 后应立即调用清理接口删除目录，不得把它当作生产日志配置。

## 10. 参考资料

- [Claude Code Hooks reference](https://code.claude.com/docs/en/hooks)
- [Codex Hooks](https://learn.chatgpt.com/docs/hooks)
- [Codex App Server](https://learn.chatgpt.com/docs/app-server)
- [Codex Build skills](https://learn.chatgpt.com/docs/build-skills)
