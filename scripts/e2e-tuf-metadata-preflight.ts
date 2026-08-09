import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { canonicalizeJson, digestText } from '@mutil-skills/e2e-contracts'
import {
  advanceTrustedMetadata,
  validateRuntimeTarget,
} from '../packages/e2e-runtime/src/runtime-update-trust.js'
import {
  TufRuntimeUpdateClient,
  readRuntimeUpdateState,
} from '../packages/e2e-runtime/src/tuf-runtime-update-client.js'

const config = requiredEnvironment([
  'E2E_TUF_PREFLIGHT_HOME', 'E2E_TUF_PREFLIGHT_TRUSTED_ROOT', 'E2E_TUF_PREFLIGHT_METADATA_URL',
  'E2E_TUF_PREFLIGHT_TARGET_URL', 'E2E_TUF_PREFLIGHT_TARGET_PATH',
  'E2E_TUF_PREFLIGHT_ALLOWED_REGISTRY_ORIGIN', 'E2E_TUF_PREFLIGHT_OUTPUT',
] as const)
const homeDir = resolve(config.E2E_TUF_PREFLIGHT_HOME)
const updateStart = new Date()
const client = new TufRuntimeUpdateClient({ homeDir,
  trustedRootPath: resolve(config.E2E_TUF_PREFLIGHT_TRUSTED_ROOT),
  metadataBaseUrl: config.E2E_TUF_PREFLIGHT_METADATA_URL,
  targetBaseUrl: config.E2E_TUF_PREFLIGHT_TARGET_URL,
  targetPath: config.E2E_TUF_PREFLIGHT_TARGET_PATH })
const refreshed = await client.refresh()
const state = advanceTrustedMetadata(await readRuntimeUpdateState(homeDir), refreshed.metadata, updateStart)
const target = validateRuntimeTarget(refreshed.target, {
  channel: 'stable', nodeVersion: process.versions.node,
  platform: supportedPlatform(process.platform), arch: supportedArch(process.arch), protocolMajor: 1,
  bootstrapVersion: process.env.E2E_TUF_PREFLIGHT_BOOTSTRAP_VERSION ?? '0.6.0',
  allowedRegistryOrigins: [config.E2E_TUF_PREFLIGHT_ALLOWED_REGISTRY_ORIGIN],
})
const draft = { schemaVersion: '1.0.0' as const, passed: true, updateStart: updateStart.toISOString(),
  target: { name: target.name, runtimeVersion: target.custom.runtimeVersion,
    installationDigest: target.custom.installationDigest, registryUrl: target.custom.registryUrl,
    revoked: target.custom.revoked },
  governance: refreshed.governance,
  metadata: state.metadata,
  previousHighwaterPreserved: true,
}
const proof = { ...draft,
  proofDigest: digestText('e2e-tuf-metadata-preflight-proof/v1', canonicalizeJson(draft)) }
const outputPath = resolve(config.E2E_TUF_PREFLIGHT_OUTPUT)
await mkdir(dirname(outputPath), { recursive: true, mode: 0o700 })
await writeFile(outputPath, `${JSON.stringify(proof, null, 2)}\n`, { mode: 0o600 })
process.stdout.write(`${JSON.stringify({ ok: true, outputPath, proofDigest: proof.proofDigest })}\n`)

function supportedPlatform(value: string): 'darwin' | 'linux' {
  if (value !== 'darwin' && value !== 'linux') throw new Error('E2E_TUF_PREFLIGHT_PLATFORM_UNSUPPORTED')
  return value
}
function supportedArch(value: string): 'arm64' | 'x64' {
  if (value !== 'arm64' && value !== 'x64') throw new Error('E2E_TUF_PREFLIGHT_ARCH_UNSUPPORTED')
  return value
}
function requiredEnvironment<const T extends readonly string[]>(names: T): Record<T[number], string> {
  const values = {} as Record<T[number], string>
  for (const name of names) {
    const value = process.env[name]
    if (value === undefined || value.trim() === '') throw new Error(`E2E_TUF_PREFLIGHT_ENV_REQUIRED:${name}`)
    values[name] = value
  }
  return values
}
