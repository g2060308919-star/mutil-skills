import { E2EError } from '@mutil-skills/e2e-contracts'

export const SECRET_RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
export const SECRET_REF_PATTERN = /^[A-Z][A-Z0-9_-]{0,127}$/
export const SECRET_DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/
export const MAX_SECRET_BYTES = 64 * 1024
export const MAX_SECRET_ENTRIES = 1024
export const MAX_SECRET_SNAPSHOT_BYTES = 4 * 1024 * 1024
export const SECRET_PROVIDER_IDS = [
  'interactive', 'macos-keychain', 'linux-secret-service',
] as const

export type SecretProviderId = typeof SECRET_PROVIDER_IDS[number]

export function isSecretProviderId(value: unknown): value is SecretProviderId {
  return typeof value === 'string' && (SECRET_PROVIDER_IDS as readonly string[]).includes(value)
}

export function assertSecretBinding(runId: string, secretRef: string, providerId: SecretProviderId): void {
  if (!SECRET_RUN_ID_PATTERN.test(runId) || !SECRET_REF_PATTERN.test(secretRef)
    || !isSecretProviderId(providerId)) {
    throw secretFailure('E2E_SECRET_INPUT_INVALID', 'runId、secretRef 或 providerId 不符合固定 grammar')
  }
}

export function secretFailure(code: string, message: string, cause?: unknown): E2EError {
  return new E2EError({ code, category: 'safety', message: `${code}: ${message}`, retryable: false, cause })
}
