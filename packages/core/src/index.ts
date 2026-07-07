export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }

export type PackageManager = 'pnpm' | 'yarn' | 'npm'

export interface PackageJsonLike {
  scripts?: Record<string, string>
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
  [key: string]: unknown
}

export interface ScriptMergeResult {
  packageJson: PackageJsonLike
  added: string[]
  skipped: string[]
}

export interface CommandSpec {
  command: string
  args: string[]
}

import { access, readdir, readFile, writeFile } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'

export class RepoError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly details?: unknown,
  ) {
    super(message)
    this.name = 'RepoError'
  }
}

export async function readJsonFile<T = JsonValue>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, 'utf8')) as T
}

export async function writeJsonFile(path: string, value: unknown): Promise<void> {
  await writeFile(path, stableStringifyJson(value), 'utf8')
}

export function stableStringifyJson(value: unknown): string {
  return `${JSON.stringify(sortJsonValue(value), null, 2)}\n`
}

function sortJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortJsonValue)
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, nested]) => [key, sortJsonValue(nested)]))
  }
  return value
}

export function mergePackageScripts(packageJson: PackageJsonLike, scripts: Record<string, string>): ScriptMergeResult {
  const nextScripts = { ...(packageJson.scripts ?? {}) }
  const added: string[] = []
  const skipped: string[] = []

  for (const [name, command] of Object.entries(scripts)) {
    if (nextScripts[name]) {
      skipped.push(name)
      continue
    }
    nextScripts[name] = command
    added.push(name)
  }

  return {
    packageJson: { ...packageJson, scripts: nextScripts },
    added,
    skipped,
  }
}

export async function detectPackageManager(cwd: string): Promise<PackageManager> {
  if (await exists(join(cwd, 'pnpm-lock.yaml'))) return 'pnpm'
  if (await exists(join(cwd, 'yarn.lock'))) return 'yarn'
  return 'npm'
}

export function buildPackageInstallCommand(manager: PackageManager, packageName: string): CommandSpec {
  if (manager === 'pnpm') return { command: 'pnpm', args: ['add', '-D', packageName] }
  if (manager === 'yarn') return { command: 'yarn', args: ['add', '--dev', packageName] }
  return { command: 'npm', args: ['install', '-D', packageName] }
}

export async function scanFiles(cwd: string, patterns: string[]): Promise<string[]> {
  const files = await walk(cwd, cwd)
  const matched = files.filter((file) => patterns.some((pattern) => matchesPattern(file, pattern)))
  return matched.sort()
}

async function walk(root: string, current: string): Promise<string[]> {
  const entries = await readdir(current, { withFileTypes: true })
  const results: string[] = []

  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'dist') {
      continue
    }
    const absolute = join(current, entry.name)
    if (entry.isDirectory()) {
      results.push(...await walk(root, absolute))
      continue
    }
    if (entry.isFile()) {
      results.push(relative(root, absolute).split(sep).join('/'))
    }
  }

  return results
}

function matchesPattern(file: string, pattern: string): boolean {
  if (pattern === '**/*.test.ts') return file.endsWith('.test.ts')
  if (pattern === '**/*.test.tsx') return file.endsWith('.test.tsx')
  if (pattern === '**/*.spec.ts') return file.endsWith('.spec.ts')
  if (pattern === '**/*.spec.tsx') return file.endsWith('.spec.tsx')
  if (pattern === 'tests/**/*.ts') return file.startsWith('tests/') && file.endsWith('.ts')
  if (pattern === 'test/**/*.ts') return file.startsWith('test/') && file.endsWith('.ts')
  if (pattern === '__tests__/**/*.ts') return file.startsWith('__tests__/') && file.endsWith('.ts')
  return false
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}
