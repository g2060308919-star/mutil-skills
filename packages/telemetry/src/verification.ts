import { appendFile, chmod, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
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
    await mkdir(dirname(this.outputPath), { recursive: true, mode: 0o700 })
    await appendFile(this.outputPath, `${JSON.stringify(event)}\n`, { encoding: 'utf8', mode: 0o600 })
    await chmod(this.outputPath, 0o600)
  }
}

export async function createTemporaryTelemetryVerification(): Promise<TemporaryTelemetryVerification> {
  await mkdir(TELEMETRY_VERIFICATION_ROOT, { recursive: true, mode: 0o700 })
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
