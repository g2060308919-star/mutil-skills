import { installHooks, isProjectTelemetryEnabled, runTelemetryHook, uninstallHooks, type HookEventName, type InstallRuntime, type Runtime } from '@mutil-skills/telemetry'

const eventNames: Record<string, HookEventName> = {
  'pre-tool-use': 'PreToolUse',
  'post-tool-use': 'PostToolUse',
  'post-tool-use-failure': 'PostToolUseFailure',
  'permission-denied': 'PermissionDenied',
  'user-prompt-submit': 'UserPromptSubmit',
  'user-prompt-expansion': 'UserPromptExpansion',
  stop: 'Stop',
  'session-end': 'SessionEnd',
}

export async function telemetryHookCommand(args: readonly string[], input: string, options: { homeDir?: string } = {}): Promise<void> {
  const runtime = parseRuntime(flag(args, '--runtime'))
  const eventFlag = flag(args, '--event')
  const eventName = eventNames[eventFlag]
  if (!eventName) throw new Error(`Unsupported telemetry event: ${eventFlag}`)
  const cwd = extractTopLevelString(input, 'cwd') ?? process.cwd()
  if (!await isProjectTelemetryEnabled({ cwd, homeDir: options.homeDir })) return
  const payload: unknown = JSON.parse(input)
  await runTelemetryHook({ runtime, eventName, payload, homeDir: options.homeDir })
}

function extractTopLevelString(input: string, key: string): string | null {
  let depth = 0
  let index = 0
  while (index < input.length) {
    const character = input[index]
    if (character === '{' || character === '[') {
      depth += 1
      index += 1
      continue
    }
    if (character === '}' || character === ']') {
      depth -= 1
      index += 1
      continue
    }
    if (character !== '"') {
      index += 1
      continue
    }
    const token = readJsonString(input, index)
    if (!token) return null
    index = token.end
    if (depth !== 1 || token.value !== key) continue
    while (/\s/.test(input[index] ?? '')) index += 1
    if (input[index] !== ':') continue
    index += 1
    while (/\s/.test(input[index] ?? '')) index += 1
    const value = readJsonString(input, index)
    return value?.value ?? null
  }
  return null
}

function readJsonString(input: string, start: number): { value: string, end: number } | null {
  if (input[start] !== '"') return null
  let escaped = false
  for (let index = start + 1; index < input.length; index += 1) {
    const character = input[index]
    if (!escaped && character === '"') {
      const raw = input.slice(start, index + 1)
      try {
        return { value: JSON.parse(raw) as string, end: index + 1 }
      } catch {
        return null
      }
    }
    escaped = !escaped && character === '\\'
    if (character !== '\\') escaped = false
  }
  return null
}

export async function installHooksCommand(args: readonly string[]): Promise<string> {
  const runtime = parseInstallRuntime(flag(args, '--runtime', 'all'))
  await installHooks({ runtime, command: 'telemetry-hook' })
  return runtime === 'codex' || runtime === 'all'
    ? 'Hooks installed. Codex may ask you to trust the user-level command hooks at runtime.'
    : 'Hooks installed.'
}

export async function uninstallHooksCommand(args: readonly string[]): Promise<string> {
  const runtime = parseInstallRuntime(flag(args, '--runtime', 'all'))
  await uninstallHooks({ runtime, command: 'telemetry-hook' })
  return 'Hooks uninstalled.'
}

function flag(args: readonly string[], name: string, fallback?: string): string {
  const index = args.indexOf(name)
  const value = index >= 0 ? args[index + 1] : fallback
  if (!value) throw new Error(`Missing required flag: ${name}`)
  return value
}

function parseRuntime(value: string): Runtime {
  if (value === 'claude-code' || value === 'codex') return value
  throw new Error(`Unsupported runtime: ${value}`)
}

function parseInstallRuntime(value: string): InstallRuntime {
  if (value === 'all') return value
  return parseRuntime(value)
}
