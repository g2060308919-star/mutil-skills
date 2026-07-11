import { chmod, mkdir, mkdtemp, lstat, open, readFile, rm } from 'node:fs/promises'
import { constants } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import type { TelemetryLifecycleEvent, TelemetrySink } from './index.js'

export const TELEMETRY_VERIFICATION_ROOT = join(tmpdir(), 'mutil-skills-telemetry-verification')

export interface TemporaryTelemetryVerification {
  outputPath: string
  sink: TelemetrySink
  readEvents(): Promise<TelemetryLifecycleEvent[]>
  cleanup(): Promise<void>
}

export class TemporaryJsonlTelemetrySink implements TelemetrySink {
  readonly outputPath: string

  constructor(outputPath: string) {
    this.outputPath = assertTemporaryVerificationPath(outputPath)
  }

  async send(event: TelemetryLifecycleEvent): Promise<void> {
    await ensureSafeDirectory(TELEMETRY_VERIFICATION_ROOT)
    await mkdir(dirname(this.outputPath), { recursive: true, mode: 0o700 })
    await assertNoSymlinkComponents(dirname(this.outputPath))
    const handle = await open(
      this.outputPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | (constants.O_NOFOLLOW ?? 0),
      0o600,
    )
    try {
      await handle.writeFile(`${JSON.stringify(event)}\n`, 'utf8')
      await chmod(this.outputPath, 0o600)
    } finally {
      await handle.close()
    }
  }
}

export async function createTemporaryTelemetryVerification(): Promise<TemporaryTelemetryVerification> {
  await ensureSafeDirectory(TELEMETRY_VERIFICATION_ROOT)
  const sessionDirectory = await mkdtemp(join(TELEMETRY_VERIFICATION_ROOT, 'session-'))
  await chmod(sessionDirectory, 0o700)
  const outputPath = join(sessionDirectory, 'events.jsonl')
  const sink = new TemporaryJsonlTelemetrySink(outputPath)
  return {
    outputPath,
    sink,
    async readEvents() {
      try {
        const text = await readFile(outputPath, 'utf8')
        return text.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line) as TelemetryLifecycleEvent)
      } catch (error) {
        if (hasErrorCode(error, 'ENOENT')) return []
        throw error
      }
    },
    async cleanup() {
      await rm(sessionDirectory, { recursive: true, force: true })
    },
  }
}

async function ensureSafeDirectory(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const metadata = await lstat(directory)
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error('Verification directory must not be a symbolic link')
  }
}

async function assertNoSymlinkComponents(directory: string): Promise<void> {
  const root = resolve(TELEMETRY_VERIFICATION_ROOT)
  let current = resolve(directory)
  while (current === root || current.startsWith(`${root}/`)) {
    const metadata = await lstat(current)
    if (metadata.isSymbolicLink()) throw new Error('Verification path must not contain symbolic links')
    if (current === root) return
    current = dirname(current)
  }
  throw new Error('Verification path escaped its root')
}

function assertTemporaryVerificationPath(outputPath: string): string {
  const normalizedRoot = resolve(TELEMETRY_VERIFICATION_ROOT)
  const normalizedPath = resolve(outputPath)
  const relation = relative(normalizedRoot, normalizedPath)
  if (!relation || relation.startsWith('..') || relation.includes('/../')) {
    throw new Error('Verification output must be inside the telemetry verification directory')
  }
  return normalizedPath
}

function hasErrorCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code
}
