import type { HookEventName } from '../../index.js'

export const CODEX_HOOK_DEFINITIONS = [
  ['PreToolUse', 'pre-tool-use', 'mcp__.*|Bash|shell_command|exec_command|unified_exec'],
  ['PostToolUse', 'post-tool-use', 'mcp__.*|Bash|shell_command|exec_command|unified_exec'],
  ['Stop', 'stop', ''],
] as const satisfies readonly (readonly [HookEventName, string, string])[]
