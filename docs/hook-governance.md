# Hook 集中治理说明

## 1. 目的

将仓库中所有“运行时 Hook、Hook 适配器、Hook 安装器、Hook 验收工具和 Hook 测试”收拢到一个明确的库边界，避免 Hook 逻辑继续分散在 `packages/hooks`、`packages/cli` 和多个脚本中。

这份文档描述已落地的治理边界。迁移后的 Hook 运行时和用户级配置路径必须保持兼容。

## 2. 目标目录

新增唯一的 Hook 所有者：

```text
packages/hooks/
├── package.json                 # @mutil-skills/hooks
├── tsconfig.json
├── src/
│   ├── index.ts                 # 稳定公共 API
│   ├── mcp-skill-telemetry/
│   │   ├── shared/              # 统一事件、reducer、统计与 sink
│   │   ├── codex/               # Codex hook 定义与 transcript 适配
│   │   └── claude-code/         # Claude Code hook 定义与 transcript 适配
│   ├── runtime/                 # stdin、安装、卸载、稳定运行时
│   └── bin/                     # 三个可执行入口
└── test/                        # Hook 公共行为测试
```

## 3. 现有文件的归属

### 3.1 必须迁入 `packages/hooks`

- 原分散的统计实现已迁入 `packages/hooks/src/mcp-skill-telemetry/shared/*`
- `packages/cli/src/telemetry.ts` 中的 Hook 运行、安装、卸载和稳定运行时逻辑
- `packages/cli/src/bin/telemetry-hook.ts`
- `packages/cli/src/bin/install-hooks.ts`
- `packages/cli/src/bin/uninstall-hooks.ts`
- 与上述逻辑对应的测试和脱敏 transcript fixture

### 3.2 `packages/cli` 迁移后的职责

`packages/cli` 只保留通用 CLI 功能，例如 `repo-test` 和 `repo-tdd`。

如果为了兼容旧命令仍保留 Hook bin，只能保留薄包装器：包装器只转发到 `@mutil-skills/hooks`，不得包含事件识别、状态判断、配置合并或 transcript 解析逻辑。

### 3.3 不迁入 Hook 目录的内容

- 业务无关的 `core`、`schema`、`skills`、`template` 实现。
- E2E 业务中的浏览器、权限、报告和网关逻辑。
- 用户机器上的运行时产物：`~/.mutil-skills/runtime`、`~/.mutil-skills/telemetry.key`。

## 4. 包和兼容策略

目标包名为 `@mutil-skills/hooks`。旧的 telemetry facade 已删除；所有代码只能依赖 `@mutil-skills/hooks`。

稳定运行时的外部路径继续使用：

```text
~/.mutil-skills/runtime/cli/bin/telemetry-hook.js
```

这样迁移不会要求用户重新修改 Claude Code 或 Codex 的配置，也不会让旧安装指向仓库内的 `dist`。

## 5. Hook 分层规则

每个 Hook 必须明确属于以下一层：

| 层 | 责任 | 禁止事项 |
|---|---|---|
| domain | 统一事件、错误码、生命周期和统计公式 | 读取 stdin、修改用户配置、访问网络 |
| adapter | 解析 Claude Code/Codex 的 payload 和 transcript | 直接写文件或决定上报策略 |
| runtime | 读取 stdin、调用 adapter、fail-open、调用 sink | 重复实现业务统计规则 |
| installation | 合并/卸载用户 Hook 配置、生成密钥、安装稳定运行时 | 删除未知配置、覆盖用户 Hook |
| sink | 接收标准化事件 | 默认持久化、默认联网、输出敏感 payload |
| bin | 参数解析和进程入口 | 包含业务逻辑 |

新增 Hook 必须先定义 runtime、事件名、matcher、输入 schema、输出状态和失败码，再实现 adapter。

## 6. 兼容和安全不变量

迁移前后必须保持：

- Claude Code 使用 `~/.claude/settings.json`；Codex 使用 `~/.codex/hooks.json`。
- 安装幂等，只添加本项目拥有的 Hook。
- 卸载只删除本项目拥有的 Hook，不破坏用户其他配置。
- Hook 失败必须 fail-open，不阻断原始 MCP/Skill 调用。
- 默认使用 `NoopTelemetrySink`，不落盘、不联网、不打印敏感 payload。
- HMAC 项目标识和错误码 schema 不变。
- 同一 `callId` 的实时 Hook 与 transcript 记录只能统计一次。
- Skill 重试必须分别计数；MCP 和 Skill 的最终状态只能是 `success` 或 `failure`。

## 7. 迁移顺序

### 阶段一：建立新边界

- 创建 `packages/hooks` package 和目录骨架。
- 复制并拆分现有 Hook 测试，先让新包通过现有 44 个 Hook 相关测试。
- 建立 `@mutil-skills/hooks` 的公共导出。

### 阶段二：迁移实现

- 按“domain → adapter → runtime → installation → bin”顺序移动实现。
- 将 Codex 直接 Skill 注入 transcript 解析和 Claude Code 读取解析分别放入对应 adapter。
- 删除旧 telemetry package，避免出现双重包边界。

### 阶段三：切换 CLI 和稳定运行时

- `packages/cli` 改为调用 `@mutil-skills/hooks`。
- 稳定运行时打包改为复制 `@mutil-skills/hooks`。
- 用临时 HOME 验证安装、重复安装、卸载和回滚。

### 阶段四：清理和封存

- 删除旧 telemetry package 及其包元数据、路径别名和 workspace 引用。
- 更新 README、ADR、统计说明和 Spec 的路径。
- 完成一次 Claude Code 和一次 Codex 真实运行时验收。

## 8. 完成验收

迁移只有同时满足以下条件才算完成：

- `rg` 检查显示 Hook 业务实现只存在于 `packages/hooks`。
- `packages/cli` 中没有事件识别、transcript 解析或统计 reducer。
- Claude Code 和 Codex 安装/卸载测试通过。
- MCP 成功、MCP 失败、Skill 成功、Skill 失败、重试和无结果测试通过。
- 稳定运行时不依赖当前仓库 checkout 或 workspace `dist`。
- 原有用户 Hook 配置在安装和卸载前后保持不变。
- 不存在旧 telemetry package 或路径引用。
- 实机验收记录明确写出运行时版本、事件数量、成功/失败数量和错误码。

## 9. 当前迁移状态

已完成迁移和清理：

- `packages/hooks` 已成为实现包，包含统一域模型、reducer、验证 sink、Hook 运行器和稳定运行时。
- `packages/hooks/src/mcp-skill-telemetry/codex` 与 `packages/hooks/src/mcp-skill-telemetry/claude-code` 已分别放置运行时 Hook 定义和 transcript 解析文件。
- 旧 telemetry package 已删除，`@mutil-skills/hooks` 是唯一 Hook 包。
- `packages/cli` 的 Hook 文件现在是兼容包装器；稳定运行时复制 `@mutil-skills/hooks`。

后续只需持续维护：

- 清理和统一旧命名（例如内部 `telemetry` 变量名）。
- 在真实 Claude Code 环境完成一次安装、成功、失败和卸载验收。

## 10. 当前决策

本次迁移只处理 Hook 相关文件，不处理工作区中未提交的 E2E 改动。后续应继续按上述阶段拆分小提交，避免把 Hook 迁移和其他变更混在一起。

下一步应完成真实 Claude Code 验收。
