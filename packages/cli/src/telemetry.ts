import {
  TemporaryJsonlTelemetrySink,
  installHooks,
  isProjectTelemetryEnabled,
  runTelemetryHook,
  uninstallHooks,
  type HookEventName,
  type InstallRuntime,
  type Runtime,
  type TelemetrySink,
} from '@mutil-skills/telemetry'
import { chmod, copyFile, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

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

export interface TelemetryHookCommandOptions {
  homeDir?: string
  sink?: TelemetrySink
}

export async function telemetryHookCommand(args: readonly string[], input: string, options: TelemetryHookCommandOptions = {}): Promise<void> {
  const runtime = parseRuntime(flag(args, '--runtime'))
  const eventFlag = flag(args, '--event')
  const eventName = eventNames[eventFlag]
  if (!eventName) throw new Error(`Unsupported telemetry event: ${eventFlag}`)
  const cwd = extractTopLevelString(input, 'cwd') ?? process.cwd()
  if (!await isProjectTelemetryEnabled({ cwd, homeDir: options.homeDir })) return
  const payload: unknown = JSON.parse(input)
  await runTelemetryHook({ runtime, eventName, payload, homeDir: options.homeDir, sink: options.sink })
}

export function verificationSinkFromEnvironment(
  environment: Record<string, string | undefined>,
): TelemetrySink | undefined {
  const outputPath = environment.MUTIL_TELEMETRY_VERIFICATION_OUTPUT
  return outputPath ? new TemporaryJsonlTelemetrySink(outputPath) : undefined
}

export interface StableTelemetryRuntimeOptions {
  homeDir?: string
  sourceCliDirectory?: string
  sourceTelemetryRoot?: string
}

export async function installStableTelemetryRuntime(options: StableTelemetryRuntimeOptions = {}): Promise<string> {
  const homeDir = options.homeDir ?? process.env.HOME ?? process.cwd()
  const currentCliDirectory = dirname(fileURLToPath(import.meta.url))
  const sourceCliDirectory = options.sourceCliDirectory ?? (existsSync(join(currentCliDirectory, 'bin', 'telemetry-hook.js'))
    ? currentCliDirectory
    : resolve(currentCliDirectory, '../dist/src'))
  const sourceTelemetryRoot = options.sourceTelemetryRoot ?? resolveTelemetryPackageRoot(currentCliDirectory)
  const runtimeRoot = join(homeDir, '.mutil-skills', 'runtime')
  const destinationCli = join(runtimeRoot, 'cli')
  const destinationBin = join(destinationCli, 'bin')
  const destinationTelemetry = join(runtimeRoot, 'node_modules', '@mutil-skills', 'telemetry')
  const markerPath = join(runtimeRoot, '.mutil-skills-telemetry-runtime')

  if (existsSync(runtimeRoot) && !await isOwnedTelemetryRuntime(runtimeRoot)) {
    throw new Error(`Refusing to replace an unowned runtime directory: ${runtimeRoot}`)
  }

  await mkdir(runtimeRoot, { recursive: true, mode: 0o700 })
  const stagingRoot = await mkdtemp(join(runtimeRoot, '.staging-'))
  const stagingCli = join(stagingRoot, 'cli')
  const stagingBin = join(stagingCli, 'bin')
  const stagingTelemetry = join(stagingRoot, 'node_modules', '@mutil-skills', 'telemetry')
  try {
    await mkdir(stagingBin, { recursive: true, mode: 0o700 })
    await mkdir(join(stagingTelemetry, 'dist', 'src'), { recursive: true, mode: 0o700 })
    await copyFile(join(sourceCliDirectory, 'telemetry.js'), join(stagingCli, 'telemetry.js'))
    await copyFile(join(sourceCliDirectory, 'bin', 'telemetry-hook.js'), join(stagingBin, 'telemetry-hook.js'))
    await chmod(join(stagingBin, 'telemetry-hook.js'), 0o700)

    for (const file of await readdir(join(sourceTelemetryRoot, 'dist', 'src'))) {
      if (file.endsWith('.js')) {
        await copyFile(
          join(sourceTelemetryRoot, 'dist', 'src', file),
          join(stagingTelemetry, 'dist', 'src', file),
        )
      }
    }
    await copyFile(join(sourceTelemetryRoot, 'package.json'), join(stagingTelemetry, 'package.json'))
    await rm(destinationCli, { recursive: true, force: true })
    await rm(destinationTelemetry, { recursive: true, force: true })
    await rename(stagingCli, destinationCli)
    await mkdir(dirname(destinationTelemetry), { recursive: true, mode: 0o700 })
    await rename(stagingTelemetry, destinationTelemetry)
    await writeFile(markerPath, 'mutil-skills telemetry runtime\n', { mode: 0o600 })
    await chmod(runtimeRoot, 0o700)
  } finally {
    await rm(stagingRoot, { recursive: true, force: true })
  }
  return join(destinationBin, 'telemetry-hook.js')
}

async function isOwnedTelemetryRuntime(runtimeRoot: string): Promise<boolean> {
  if (existsSync(join(runtimeRoot, '.mutil-skills-telemetry-runtime'))) return true
  try {
    const packageJson = JSON.parse(await readFile(join(runtimeRoot, 'node_modules', '@mutil-skills', 'telemetry', 'package.json'), 'utf8')) as { name?: string }
    return packageJson.name === '@mutil-skills/telemetry' && existsSync(join(runtimeRoot, 'cli', 'bin', 'telemetry-hook.js'))
  } catch {
    return false
  }
}

export async function removeStableTelemetryRuntime(homeDir = process.env.HOME ?? process.cwd()): Promise<void> {
  const runtimeRoot = join(homeDir, '.mutil-skills', 'runtime')
  if (!await isOwnedTelemetryRuntime(runtimeRoot)) return
  await rm(join(runtimeRoot, 'cli'), { recursive: true, force: true })
  await rm(join(runtimeRoot, 'node_modules', '@mutil-skills', 'telemetry'), { recursive: true, force: true })
  await rm(join(runtimeRoot, '.mutil-skills-telemetry-runtime'), { force: true })
}

function resolveTelemetryPackageRoot(currentCliDirectory: string): string {
  const candidates = [
    resolve(currentCliDirectory, '../../../telemetry'),
    resolve(currentCliDirectory, '../../../../node_modules/@mutil-skills/telemetry'),
    resolve(process.cwd(), 'packages/telemetry'),
  ]
  const root = candidates.find((candidate) => existsSync(join(candidate, 'package.json')))
  if (!root) throw new Error('Cannot locate the installed @mutil-skills/telemetry package')
  return root
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
  const previousExecutable = resolveTelemetryHookExecutable()
  const stableExecutable = await installStableTelemetryRuntime()
  await installHooks({ runtime, command: stableExecutable })
  await uninstallHooks({ runtime, command: previousExecutable })
  return runtime === 'codex' || runtime === 'all'
    ? 'Hooks installed. Codex may ask you to trust the user-level command hooks at runtime.'
    : 'Hooks installed.'
}

export async function uninstallHooksCommand(args: readonly string[]): Promise<string> {
  const runtime = parseInstallRuntime(flag(args, '--runtime', 'all'))
  const stableExecutable = join(process.env.HOME ?? process.cwd(), '.mutil-skills', 'runtime', 'cli', 'bin', 'telemetry-hook.js')
  await uninstallHooks({ runtime, command: stableExecutable })
  await uninstallHooks({ runtime, command: resolveTelemetryHookExecutable() })
  if (runtime === 'all') {
    await removeStableTelemetryRuntime()
  }
  return 'Hooks uninstalled.'
}

export function resolveTelemetryHookExecutable(): string {
  return fileURLToPath(new URL('./bin/telemetry-hook.js', import.meta.url))
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
