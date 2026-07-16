import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto'
import { E2EError, type SealedEvidenceEnvelope } from '@mutil-skills/e2e-contracts'

export interface QuarantineKeyHandle {
  keyId: string
}

export interface QuarantineSecretProvider {
  createRunKey(input: { runId: string; expiresAt: string }): Promise<QuarantineKeyHandle>
  seal(input: { keyId: string; plaintext: Uint8Array; aad: Uint8Array; aadDigest: string }): Promise<SealedEvidenceEnvelope>
  open(input: { keyId: string; envelope: SealedEvidenceEnvelope; aad: Uint8Array }): Promise<Uint8Array>
  destroyKey(keyId: string): Promise<void>
  hasKey(keyId: string): Promise<boolean>
}

export class InMemorySecretProvider implements QuarantineSecretProvider {
  readonly #keys = new Map<string, Buffer>()

  async createRunKey(input: { runId: string; expiresAt: string }): Promise<QuarantineKeyHandle> {
    if (!input.runId || Number.isNaN(Date.parse(input.expiresAt))) throw secretError('E2E_SECRET_KEY_INPUT_INVALID', '密钥输入无效')
    const keyId = `run-key:${randomUUID()}`
    this.#keys.set(keyId, randomBytes(32))
    return { keyId }
  }

  async seal(input: {
    keyId: string
    plaintext: Uint8Array
    aad: Uint8Array
    aadDigest: string
  }): Promise<SealedEvidenceEnvelope> {
    const key = this.requireKey(input.keyId)
    const iv = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', key, iv, { authTagLength: 16 })
    cipher.setAAD(input.aad)
    const ciphertext = Buffer.concat([cipher.update(input.plaintext), cipher.final()])
    return {
      schemaVersion: '1.0.0', keyId: input.keyId, algorithm: 'AES-256-GCM',
      iv: iv.toString('base64'), authTag: cipher.getAuthTag().toString('base64'),
      ciphertext: ciphertext.toString('base64'), aadDigest: input.aadDigest,
    }
  }

  async open(input: { keyId: string; envelope: SealedEvidenceEnvelope; aad: Uint8Array }): Promise<Uint8Array> {
    const key = this.requireKey(input.keyId)
    if (input.envelope.keyId !== input.keyId || input.envelope.algorithm !== 'AES-256-GCM') {
      throw secretError('E2E_SECRET_ENVELOPE_KEY_MISMATCH', '密文 envelope 与 key handle 不匹配')
    }
    try {
      const decipher = createDecipheriv(
        'aes-256-gcm', key, Buffer.from(input.envelope.iv, 'base64'), { authTagLength: 16 },
      )
      decipher.setAAD(input.aad)
      decipher.setAuthTag(Buffer.from(input.envelope.authTag, 'base64'))
      return Buffer.concat([
        decipher.update(Buffer.from(input.envelope.ciphertext, 'base64')),
        decipher.final(),
      ])
    } catch (cause) {
      throw secretError('E2E_SECRET_AUTHENTICATION_FAILED', '密文认证失败', cause)
    }
  }

  async destroyKey(keyId: string): Promise<void> {
    const key = this.#keys.get(keyId)
    if (key) key.fill(0)
    this.#keys.delete(keyId)
  }

  async hasKey(keyId: string): Promise<boolean> {
    return this.#keys.has(keyId)
  }

  private requireKey(keyId: string): Buffer {
    const key = this.#keys.get(keyId)
    if (!key) throw secretError('E2E_SECRET_KEY_UNAVAILABLE', 'Quarantine 数据密钥不存在或已销毁')
    return key
  }
}

function secretError(code: string, message: string, cause?: unknown): E2EError {
  return new E2EError({ code, category: 'safety', message, retryable: false, cause })
}
