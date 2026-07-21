import { afterEach, describe, expect, test } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runtimeLayout } from '../packages/e2e-runtime/src/runtime-layout.js'
import {
  inspectRuntimeCapabilityProof,
  recordRuntimeCapabilityProof,
} from '../packages/e2e-runtime/src/runtime-capability-proof.js'
import { copyVerifiedCapabilityProof } from './e2e-runtime-read-only-installation.js'

const DIGEST_A = `sha256:${'a'.repeat(64)}`
const DIGEST_B = `sha256:${'b'.repeat(64)}`
const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true })))
})

describe('真实 Runtime Golden capability proof 前置闭环', () => {
  test('只复制已验证且绑定当前安装的 capability proof', async () => {
    const { sourceHome, targetHome } = await homes()
    const source = await seedProof(sourceHome, DIGEST_A)

    const copied = await copyVerifiedCapabilityProof(sourceHome, targetHome, DIGEST_A)

    expect(copied).toEqual(source)
    await expect(inspectRuntimeCapabilityProof({
      homeDir: targetHome,
      runtimeInstallationDigest: DIGEST_A,
    })).resolves.toEqual(source)
  })

  test('源 HOME 缺少 capability proof 时拒绝启动 Golden', async () => {
    const { sourceHome, targetHome } = await homes()

    await expect(copyVerifiedCapabilityProof(sourceHome, targetHome, DIGEST_A)).rejects.toMatchObject({
      code: 'E2E_RUNTIME_CAPABILITY_PROOF_NOT_INSTALLED',
    })
  })

  test('源 HOME capability proof 损坏时拒绝启动 Golden', async () => {
    const { sourceHome, targetHome } = await homes()
    await mkdir(runtimeLayout(sourceHome).state, { recursive: true, mode: 0o700 })
    await writeFile(
      join(runtimeLayout(sourceHome).state, 'runtime-capability-proof.json'),
      '{"schemaVersion":"corrupted"}\n',
      { mode: 0o600 },
    )

    await expect(copyVerifiedCapabilityProof(sourceHome, targetHome, DIGEST_A)).rejects.toMatchObject({
      code: 'E2E_RUNTIME_CAPABILITY_PROOF_BINDING_MISMATCH',
    })
  })

  test('源 HOME capability proof 与安装摘要错绑定时拒绝启动 Golden', async () => {
    const { sourceHome, targetHome } = await homes()
    await seedProof(sourceHome, DIGEST_A)

    await expect(copyVerifiedCapabilityProof(sourceHome, targetHome, DIGEST_B)).rejects.toMatchObject({
      code: 'E2E_RUNTIME_CAPABILITY_PROOF_BINDING_MISMATCH',
    })
  })
})

async function homes(): Promise<{ sourceHome: string; targetHome: string }> {
  const root = await mkdtemp(join(tmpdir(), 'runtime-proof-copy-test-'))
  roots.push(root)
  const sourceHome = join(root, 'source-home')
  const targetHome = join(root, 'target-home')
  await Promise.all([
    mkdir(runtimeLayout(sourceHome).state, { recursive: true, mode: 0o700 }),
    mkdir(targetHome, { recursive: true, mode: 0o700 }),
  ])
  return { sourceHome, targetHome }
}

async function seedProof(homeDir: string, runtimeInstallationDigest: string) {
  return await recordRuntimeCapabilityProof({
    homeDir,
    runtimeInstallationDigest,
    gateway: {
      sessionMeasurementDigest: `sha256:${'1'.repeat(64)}`,
      policyDigest: `sha256:${'2'.repeat(64)}`,
      auditDigest: `sha256:${'3'.repeat(64)}`,
    },
    isolation: {
      browserMeasurementDigest: `sha256:${'4'.repeat(64)}`,
      sandboxProfileDigest: `sha256:${'5'.repeat(64)}`,
      canaryProofDigest: `sha256:${'6'.repeat(64)}`,
      browserClosureDigest: `sha256:${'7'.repeat(64)}`,
      browserExecutableDigest: `sha256:${'8'.repeat(64)}`,
    },
    verifiedAt: new Date().toISOString(),
  })
}
