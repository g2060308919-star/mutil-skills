import type { HookEventName } from '../../index.js'

export const CLAUDE_CODE_HOOK_DEFINITIONS = [
  ['UserPromptSubmit', 'user-prompt-submit', ''],
  ['PreToolUse', 'pre-tool-use', 'mcp__.*|Skill|Read|Bash'],
  ['PostToolUse', 'post-tool-use', 'mcp__.*|Skill|Read|Bash'],
  ['PostToolUseFailure', 'post-tool-use-failure', 'mcp__.*|Skill|Read|Bash'],
  ['PermissionDenied', 'permission-denied', 'mcp__.*|Skill|Read|Bash'],
  ['UserPromptExpansion', 'user-prompt-expansion', ''],
  ['Stop', 'stop', ''],
  ['SessionEnd', 'session-end', ''],
] as const satisfies readonly (readonly [HookEventName, string, string])[]
