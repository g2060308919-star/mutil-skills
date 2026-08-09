import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { auditStableRuntimeActivation } from '../packages/e2e-runtime/src/stable-activation-audit.js'
import { TufRuntimeUpdateClient } from '../packages/e2e-runtime/src/tuf-runtime-update-client.js'

const config = requiredEnvironment([
  'E2E_STABLE_AUDIT_HOME', 'E2E_STABLE_TRUSTED_ROOT', 'E2E_STABLE_METADATA_URL',
  'E2E_STABLE_TARGET_URL', 'E2E_STABLE_TARGET_PATH', 'E2E_STABLE_ALLOWED_REGISTRY_ORIGIN',
  'E2E_STABLE_PERFORMANCE_PROOF', 'E2E_STABLE_B2B_PROOF', 'E2E_STABLE_OPERATIONAL_PROOF',
  'E2E_STABLE_REGISTRY_GOLDEN_PROOF', 'E2E_STABLE_REVOCATION_DRILL_PROOF',
  'E2E_STABLE_LKG_DRILL_PROOF', 'E2E_STABLE_AUDIT_OUTPUT',
] as const)

const client = new TufRuntimeUpdateClient({
  homeDir: resolve(config.E2E_STABLE_AUDIT_HOME),
  trustedRootPath: resolve(config.E2E_STABLE_TRUSTED_ROOT),
  metadataBaseUrl: config.E2E_STABLE_METADATA_URL,
  targetBaseUrl: config.E2E_STABLE_TARGET_URL,
  targetPath: config.E2E_STABLE_TARGET_PATH,
})
// refresh 由官方 tuf-js 完成 root continuity、阈值签名和角色链验证；审计器不重新实现密码学。
const refreshed = await client.refresh()
const output = auditStableRuntimeActivation({
  ...refreshed,
  updateStart: new Date(),
  environment: {
    channel: 'stable', nodeVersion: process.versions.node,
    platform: supportedPlatform(process.platform), arch: supportedArch(process.arch),
    protocolMajor: 1,
    bootstrapVersion: process.env.E2E_STABLE_BOOTSTRAP_VERSION ?? '0.6.0',
    allowedRegistryOrigins: [config.E2E_STABLE_ALLOWED_REGISTRY_ORIGIN],
  },
  evidence: await Promise.all([
    json(config.E2E_STABLE_PERFORMANCE_PROOF),
    json(config.E2E_STABLE_B2B_PROOF),
    json(config.E2E_STABLE_OPERATIONAL_PROOF),
    json(config.E2E_STABLE_REGISTRY_GOLDEN_PROOF),
    json(config.E2E_STABLE_REVOCATION_DRILL_PROOF),
    json(config.E2E_STABLE_LKG_DRILL_PROOF),
  ]),
})
const outputPath = resolve(config.E2E_STABLE_AUDIT_OUTPUT)
await mkdir(dirname(outputPath), { recursive: true, mode: 0o700 })
await writeFile(outputPath, `${JSON.stringify(output, null, 2)}\n`, { mode: 0o600 })
process.stdout.write(`${JSON.stringify({ ok: output.ready, outputPath, auditDigest: output.auditDigest })}\n`)

async function json(path: string): Promise<unknown> {
  return JSON.parse(await readFile(resolve(path), 'utf8'))
}
function supportedPlatform(value: string): 'darwin' | 'linux' {
  if (value !== 'darwin' && value !== 'linux') throw new Error('E2E_STABLE_PLATFORM_UNSUPPORTED')
  return value
}
function supportedArch(value: string): 'arm64' | 'x64' {
  if (value !== 'arm64' && value !== 'x64') throw new Error('E2E_STABLE_ARCH_UNSUPPORTED')
  return value
}
function requiredEnvironment<const T extends readonly string[]>(names: T): Record<T[number], string> {
  const values = {} as Record<T[number], string>
  for (const name of names) {
    const value = process.env[name]
    if (value === undefined || value.trim() === '') throw new Error(`E2E_STABLE_ENV_REQUIRED:${name}`)
    values[name] = value
  }
  return values
}
