import { randomBytes } from 'node:crypto'
import { chmod, lstat, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { createRuntimeTestRoots } from './fixtures.js'
import { RuntimeQuarantineSecretProvider } from '../src/quarantine-secret-provider.js'

describe('RuntimeQuarantineSecretProvider', () => {
  test('以 0600 持久化包装后的 Run key，重建 provider 后仍可解密', async () => {
    const roots = await createRuntimeTestRoots()
    const quarantineRoot = join(roots.home, '.mutil-skills', 'e2e', 'quarantine')
    const masterKey = randomBytes(32)
    const first = new RuntimeQuarantineSecretProvider({
      quarantineRoot, projectRoot: roots.project, masterKey,
    })
    const key = await first.createRunKey({
      runId: 'RUN-QUARANTINE-1', expiresAt: '2026-07-18T00:00:00.000Z',
    })
    const aad = Buffer.from('bound metadata')
    const sealed = await first.seal({
      keyId: key.keyId, plaintext: Buffer.from('raw evidence'), aad,
      aadDigest: `sha256:${'a'.repeat(64)}`,
    })

    const envelopePath = join(quarantineRoot, 'RUN-QUARANTINE-1', 'key-envelope.json')
    expect((await lstat(envelopePath)).mode & 0o777).toBe(0o600)
    expect(await readFile(envelopePath, 'utf8')).not.toContain('raw evidence')

    const restarted = new RuntimeQuarantineSecretProvider({
      quarantineRoot, projectRoot: roots.project, masterKey,
    })
    await expect(restarted.open({ keyId: key.keyId, envelope: sealed, aad }))
      .resolves.toEqual(Buffer.from('raw evidence'))
    await expect(restarted.createRunKey({
      runId: 'RUN-QUARANTINE-1', expiresAt: '2026-07-18T00:00:00.000Z',
    })).rejects.toThrow(/E2E_QUARANTINE_KEY_ALREADY_EXISTS/)
    await expect(restarted.open({ keyId: key.keyId, envelope: sealed, aad }))
      .resolves.toEqual(Buffer.from('raw evidence'))
    masterKey.fill(0)
  })

  test('拒绝项目内 quarantine、宽权限目录与篡改后的 key envelope', async () => {
    const roots = await createRuntimeTestRoots()
    const masterKey = randomBytes(32)
    expect(() => new RuntimeQuarantineSecretProvider({
      quarantineRoot: join(roots.project, '.biztest', 'quarantine'),
      projectRoot: roots.project,
      masterKey,
    })).toThrow(/E2E_QUARANTINE_PROJECT_ROOT_DENIED/)

    const quarantineRoot = join(roots.home, '.mutil-skills', 'e2e', 'quarantine')
    const provider = new RuntimeQuarantineSecretProvider({ quarantineRoot, projectRoot: roots.project, masterKey })
    const key = await provider.createRunKey({
      runId: 'RUN-QUARANTINE-2', expiresAt: '2026-07-18T00:00:00.000Z',
    })
    const envelopePath = join(quarantineRoot, 'RUN-QUARANTINE-2', 'key-envelope.json')
    const document = JSON.parse(await readFile(envelopePath, 'utf8')) as Record<string, unknown>
    document.ciphertext = Buffer.from('tampered').toString('base64')
    await writeFile(envelopePath, JSON.stringify(document), { mode: 0o600 })
    await expect(provider.hasKey(key.keyId)).rejects.toThrow(/E2E_QUARANTINE_KEY_AUTHENTICATION_FAILED/)

    await mkdir(join(quarantineRoot, 'RUN-QUARANTINE-3'), { recursive: true, mode: 0o700 })
    await chmod(quarantineRoot, 0o755)
    await expect(provider.createRunKey({
      runId: 'RUN-QUARANTINE-3', expiresAt: '2026-07-18T00:00:00.000Z',
    })).rejects.toThrow(/E2E_QUARANTINE_KEY_ROOT_INSECURE/)
    masterKey.fill(0)
  })

  test('destroyKey 实施 crypto-erasure 并保持幂等', async () => {
    const roots = await createRuntimeTestRoots()
    const masterKey = randomBytes(32)
    const provider = new RuntimeQuarantineSecretProvider({
      quarantineRoot: join(roots.home, '.mutil-skills', 'e2e', 'quarantine'),
      projectRoot: roots.project,
      masterKey,
    })
    const key = await provider.createRunKey({
      runId: 'RUN-QUARANTINE-4', expiresAt: '2026-07-18T00:00:00.000Z',
    })
    await provider.destroyKey(key.keyId)
    await provider.destroyKey(key.keyId)
    await expect(provider.hasKey(key.keyId)).resolves.toBe(false)
    masterKey.fill(0)
  })

  test('shutdown 幂等清零 provider master，之后所有密钥操作 fail closed', async () => {
    const roots = await createRuntimeTestRoots()
    const masterKey = randomBytes(32)
    const provider = new RuntimeQuarantineSecretProvider({
      quarantineRoot: join(roots.home, '.mutil-skills', 'e2e', 'quarantine'),
      projectRoot: roots.project,
      masterKey,
    })
    provider.close()
    provider.close()
    await expect(provider.createRunKey({
      runId: 'RUN-CLOSED', expiresAt: '2026-07-18T00:00:00.000Z',
    })).rejects.toMatchObject({ code: 'E2E_QUARANTINE_KEY_PROVIDER_CLOSED' })
    masterKey.fill(0)
  })
})
