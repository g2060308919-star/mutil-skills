import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import {
  createRuntimeLkgRecoveryDrillArtifact,
  createRuntimeRevocationDrillArtifact,
} from '../packages/e2e-runtime/src/stable-activation-drills.js'
import {
  parseRuntimeUpdateState,
  restoreRuntimeLkg,
  SignedRuntimeTargetSchema,
} from '../packages/e2e-runtime/src/runtime-update-trust.js'
import {
  readRuntimeUpdateState,
  writeRuntimeUpdateState,
} from '../packages/e2e-runtime/src/tuf-runtime-update-client.js'

const mode = required('E2E_STABLE_DRILL_MODE')
const environmentId = required('E2E_STABLE_DRILL_ENVIRONMENT_ID')
const sourceCommit = required('E2E_STABLE_DRILL_SOURCE_COMMIT')
const outputPath = resolve(required('E2E_STABLE_DRILL_OUTPUT'))
let artifact: unknown

if (mode === 'revocation') {
  const before = parseRuntimeUpdateState(await json(required('E2E_STABLE_DRILL_STATE_BEFORE')))
  const after = parseRuntimeUpdateState(await json(required('E2E_STABLE_DRILL_STATE_AFTER')))
  const target = SignedRuntimeTargetSchema.parse(await json(required('E2E_STABLE_DRILL_TARGET')))
  artifact = createRuntimeRevocationDrillArtifact({ before, after, target, environmentId, sourceCommit,
    observedAt: new Date(required('E2E_STABLE_DRILL_OBSERVED_AT')) })
} else if (mode === 'lkg-recovery') {
  const homeDir = resolve(required('E2E_STABLE_DRILL_HOME'))
  const before = await readRuntimeUpdateState(homeDir)
  if (before === undefined) throw new Error('E2E_RUNTIME_LKG_DRILL_STATE_MISSING')
  const existingBefore = required('E2E_STABLE_DRILL_EXISTING_RUN_DIGEST')
  const environment = {
    channel: 'stable' as const,
    nodeVersion: process.versions.node,
    platform: supportedPlatform(process.platform),
    arch: supportedArch(process.arch),
    protocolMajor: 1,
    bootstrapVersion: required('E2E_STABLE_DRILL_BOOTSTRAP_VERSION'),
    allowedRegistryOrigins: [required('E2E_STABLE_DRILL_REGISTRY_ORIGIN')],
  }
  const restored = restoreRuntimeLkg(before, new Date(), environment)
  await writeRuntimeUpdateState(homeDir, restored)
  const after = await readRuntimeUpdateState(homeDir)
  if (after === undefined) throw new Error('E2E_RUNTIME_LKG_DRILL_STATE_LOST')
  artifact = createRuntimeLkgRecoveryDrillArtifact({ before, after, environmentId, sourceCommit,
    existingRunInstallationDigestBefore: existingBefore,
    existingRunInstallationDigestAfter: existingBefore })
} else {
  throw new Error('E2E_STABLE_DRILL_MODE_INVALID')
}

await mkdir(dirname(outputPath), { recursive: true, mode: 0o700 })
await writeFile(outputPath, `${JSON.stringify(artifact, null, 2)}\n`, { mode: 0o600 })
process.stdout.write(`${JSON.stringify({ ok: true, mode, outputPath })}\n`)

async function json(path: string): Promise<unknown> {
  return JSON.parse(await readFile(resolve(path), 'utf8'))
}
function required(name: string): string {
  const value = process.env[name]
  if (value === undefined || value.trim() === '') throw new Error(`E2E_STABLE_ENV_REQUIRED:${name}`)
  return value
}
function supportedPlatform(value: string): 'darwin' | 'linux' {
  if (value !== 'darwin' && value !== 'linux') throw new Error('E2E_STABLE_PLATFORM_UNSUPPORTED')
  return value
}
function supportedArch(value: string): 'arm64' | 'x64' {
  if (value !== 'arm64' && value !== 'x64') throw new Error('E2E_STABLE_ARCH_UNSUPPORTED')
  return value
}
