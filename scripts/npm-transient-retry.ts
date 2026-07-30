import { setTimeout as waitFor } from 'node:timers/promises'

const transientCodes = new Set([
  'EAI_AGAIN',
  'ECONNREFUSED',
  'ECONNRESET',
  'ENETUNREACH',
  'ETIMEDOUT',
])

export interface NpmTransientRetryOptions {
  readonly maxAttempts?: number
  readonly retryDelayMs?: number
  readonly wait?: (delayMs: number) => Promise<unknown>
}

export async function runWithTransientNpmRetry<T>(
  operation: () => Promise<T>,
  options: NpmTransientRetryOptions = {},
): Promise<T> {
  const maxAttempts = options.maxAttempts ?? 2
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
    throw new TypeError('maxAttempts 必须是大于等于 1 的整数')
  }
  const wait = options.wait ?? waitFor
  const retryDelayMs = options.retryDelayMs ?? 1_000

  for (let attempt = 1; ; attempt += 1) {
    try {
      return await operation()
    } catch (error) {
      if (attempt >= maxAttempts || !isTransientNpmError(error)) throw error
      await wait(retryDelayMs)
    }
  }
}

function isTransientNpmError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false
  const candidate = error as { code?: unknown; message?: unknown; stderr?: unknown; stdout?: unknown }
  if (typeof candidate.code === 'string' && transientCodes.has(candidate.code)) return true
  const details = [candidate.message, candidate.stderr, candidate.stdout]
    .filter((value): value is string => typeof value === 'string')
    .join('\n')
  return [...transientCodes].some((code) => new RegExp(`(?:^|\\W)${code}(?:\\W|$)`, 'u').test(details))
}
