import { E2EError } from '@mutil-skills/e2e-contracts'
import type { OneTimeSecretHandle, RuntimeSecretBroker } from './secret-broker.js'
import type { SecretProviderId } from './secret-contract.js'

const SAFE_REF = /^[A-Za-z0-9._:/-]{1,256}$/
const MAX_SEGMENTS = 128
const MAX_RENDERED_BYTES = 256 * 1024

export type SecretTemplateSegment =
  | { kind: 'literal'; value: string }
  | { kind: 'secretRef'; secretRef: string; providerId?: SecretProviderId }

export interface SecretTemplateBroker {
  resolve(input: { runId: string; secretRef: string; providerId?: SecretProviderId }): Promise<OneTimeSecretHandle>
  consume(handle: OneTimeSecretHandle): Promise<Buffer>
}

/**
 * Bridge 最后一刻渲染模板：模板持久化层永远只有 literal/secretRef；秘密在 dispatch
 * 前才 resolve + consume，并在 dispatch 完成或失败后清零所有 plaintext 副本。
 */
export async function executeSecretTemplateAtBridge<T>(input: {
  runId: string
  template: readonly SecretTemplateSegment[]
  broker: SecretTemplateBroker | Pick<RuntimeSecretBroker, 'resolve' | 'consume'>
  dispatch(payload: Uint8Array): Promise<T>
}): Promise<T> {
  const template = parseSecretTemplate(input.template)
  if (!SAFE_REF.test(input.runId) || typeof input.dispatch !== 'function') throw templateError()
  const chunks: Buffer[] = []
  let total = 0
  let payload: Buffer | undefined
  try {
    for (const segment of template) {
      const chunk = segment.kind === 'literal'
        ? Buffer.from(segment.value, 'utf8')
        : await consumeSecret(input.runId, segment, input.broker)
      total += chunk.byteLength
      if (total > MAX_RENDERED_BYTES) {
        chunk.fill(0)
        throw secretTemplateError('E2E_RUNTIME_SECRET_TEMPLATE_SIZE_LIMIT')
      }
      chunks.push(chunk)
    }
    payload = Buffer.allocUnsafe(total)
    let offset = 0
    for (const chunk of chunks) {
      chunk.copy(payload, offset)
      offset += chunk.byteLength
    }
    return await input.dispatch(payload)
  } finally {
    payload?.fill(0)
    for (const chunk of chunks) chunk.fill(0)
  }
}

export function parseSecretTemplate(value: unknown): SecretTemplateSegment[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_SEGMENTS) throw templateError()
  const parsed: SecretTemplateSegment[] = []
  for (const segment of value) {
    if (!plain(segment) || typeof segment.kind !== 'string') throw templateError()
    if (segment.kind === 'literal') {
      if (!exact(segment, ['kind', 'value']) || typeof segment.value !== 'string'
        || Buffer.byteLength(segment.value, 'utf8') > MAX_RENDERED_BYTES) throw templateError()
      parsed.push({ kind: 'literal', value: segment.value })
      continue
    }
    if (segment.kind === 'secretRef') {
      const hasProvider = Object.hasOwn(segment, 'providerId')
      if (!exact(segment, ['kind', 'secretRef', ...(hasProvider ? ['providerId'] : [])])
        || typeof segment.secretRef !== 'string' || !SAFE_REF.test(segment.secretRef)
        || hasProvider && !['interactive', 'macos-keychain', 'linux-secret-service', 'windows-credential-manager']
          .includes(String(segment.providerId))) throw templateError()
      parsed.push({ kind: 'secretRef', secretRef: segment.secretRef,
        ...(hasProvider ? { providerId: segment.providerId as SecretProviderId } : {}) })
      continue
    }
    throw templateError()
  }
  return parsed
}

async function consumeSecret(
  runId: string,
  segment: Extract<SecretTemplateSegment, { kind: 'secretRef' }>,
  broker: SecretTemplateBroker,
): Promise<Buffer> {
  const handle = await broker.resolve({ runId, secretRef: segment.secretRef,
    ...(segment.providerId === undefined ? {} : { providerId: segment.providerId }) })
  const secret = await broker.consume(handle)
  if (!Buffer.isBuffer(secret) || secret.byteLength === 0) {
    secret?.fill(0)
    throw secretTemplateError('E2E_RUNTIME_SECRET_TEMPLATE_CONSUME_INVALID')
  }
  return secret
}

function plain(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype
}
function exact(value: Record<string, unknown>, keys: string[]): boolean {
  return Object.keys(value).sort().join('\0') === [...keys].sort().join('\0')
}
function templateError(): E2EError { return secretTemplateError('E2E_RUNTIME_SECRET_TEMPLATE_INVALID') }
function secretTemplateError(code: string): E2EError {
  return new E2EError({ code, category: 'safety', message: code, retryable: false })
}
