import { canonicalizeJson, digestText, E2EError } from '@mutil-skills/e2e-contracts'
import { constants } from 'node:fs'
import { lstat, open, rename, unlink } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { z } from 'zod'
import { runtimeLayout } from './runtime-layout.js'

const DigestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/)
const CapabilityProofBodySchema = z.object({
  schemaVersion: z.literal('1.0.0'),
  runtimeInstallationDigest: DigestSchema,
  gateway: z.object({
    sessionMeasurementDigest: DigestSchema, policyDigest: DigestSchema,
    auditDigest: DigestSchema,
  }).strict(),
  isolation: z.object({
    browserMeasurementDigest: DigestSchema, sandboxProfileDigest: DigestSchema,
    canaryProofDigest: DigestSchema, browserClosureDigest: DigestSchema,
    browserExecutableDigest: DigestSchema,
  }).strict(),
  verifiedAt: z.string().datetime(),
}).strict()
const CapabilityProofSchema = CapabilityProofBodySchema.extend({ proofDigest: DigestSchema }).strict()

export type RuntimeCapabilityProof = z.infer<typeof CapabilityProofSchema>

export async function recordRuntimeCapabilityProof(input: {
  homeDir: string
  runtimeInstallationDigest: string
  gateway: RuntimeCapabilityProof['gateway']
  isolation: RuntimeCapabilityProof['isolation']
  verifiedAt: string
}): Promise<RuntimeCapabilityProof> {
  const body = CapabilityProofBodySchema.parse({
    schemaVersion: '1.0.0', runtimeInstallationDigest: input.runtimeInstallationDigest,
    gateway: input.gateway, isolation: input.isolation, verifiedAt: input.verifiedAt,
  })
  const proof = CapabilityProofSchema.parse({
    ...body, proofDigest: digestText('runtime-capability-proof/v1', canonicalizeJson(body)),
  })
  const state = runtimeLayout(input.homeDir).state
  await requirePrivateStateDirectory(state)
  const target = join(state, 'runtime-capability-proof.json')
  const temporary = join(state, `.runtime-capability-proof-${randomUUID()}.tmp`)
  let handle
  try {
    handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
    await handle.writeFile(`${canonicalizeJson(proof)}\n`, 'utf8')
    await handle.sync()
    await handle.close(); handle = undefined
    await rename(temporary, target)
    const directory = await open(state, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
    try { await directory.sync() } finally { await directory.close() }
    return proof
  } finally {
    await handle?.close().catch(() => undefined)
    await unlink(temporary).catch(() => undefined)
  }
}

export async function inspectRuntimeCapabilityProof(input: {
  homeDir: string
  runtimeInstallationDigest: string
  now?: Date
}): Promise<RuntimeCapabilityProof> {
  const state = runtimeLayout(input.homeDir).state
  await requirePrivateStateDirectory(state)
  const path = join(state, 'runtime-capability-proof.json')
  let handle
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  } catch (cause) {
    if (isNodeError(cause, 'ENOENT')) throw proofError('E2E_RUNTIME_CAPABILITY_PROOF_NOT_INSTALLED', cause)
    throw proofError('E2E_RUNTIME_CAPABILITY_PROOF_UNSAFE', cause)
  }
  try {
    const stat = await handle.stat()
    if (!stat.isFile() || stat.uid !== currentUid() || stat.nlink !== 1
      || (stat.mode & 0o777) !== 0o600 || stat.size > 64 * 1024) {
      throw proofError('E2E_RUNTIME_CAPABILITY_PROOF_UNSAFE')
    }
    const parsed = CapabilityProofSchema.safeParse(JSON.parse(await handle.readFile('utf8')))
    if (!parsed.success || parsed.data.runtimeInstallationDigest !== input.runtimeInstallationDigest) {
      throw proofError('E2E_RUNTIME_CAPABILITY_PROOF_BINDING_MISMATCH', parsed.success ? undefined : parsed.error)
    }
    const { proofDigest, ...body } = parsed.data
    if (proofDigest !== digestText('runtime-capability-proof/v1', canonicalizeJson(body))) {
      throw proofError('E2E_RUNTIME_CAPABILITY_PROOF_DIGEST_MISMATCH')
    }
    const now = (input.now ?? new Date()).getTime()
    const verifiedAt = Date.parse(parsed.data.verifiedAt)
    if (!Number.isFinite(now) || verifiedAt > now || now - verifiedAt > 24 * 60 * 60 * 1_000) {
      throw proofError('E2E_RUNTIME_CAPABILITY_PROOF_STALE')
    }
    return parsed.data
  } catch (cause) {
    if (cause instanceof E2EError) throw cause
    throw proofError('E2E_RUNTIME_CAPABILITY_PROOF_INVALID', cause)
  } finally { await handle.close() }
}

async function requirePrivateStateDirectory(path: string): Promise<void> {
  let stat
  try { stat = await lstat(path) } catch (cause) {
    if (isNodeError(cause, 'ENOENT')) throw proofError('E2E_RUNTIME_CAPABILITY_PROOF_NOT_INSTALLED', cause)
    throw proofError('E2E_RUNTIME_CAPABILITY_PROOF_UNSAFE', cause)
  }
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== currentUid()
    || (stat.mode & 0o777) !== 0o700) {
    throw proofError('E2E_RUNTIME_CAPABILITY_PROOF_UNSAFE')
  }
}

function currentUid(): number {
  const uid = process.getuid?.()
  if (uid === undefined) throw proofError('E2E_RUNTIME_CAPABILITY_PROOF_UNSAFE')
  return uid
}

function proofError(code: string, cause?: unknown): E2EError {
  return new E2EError({ code, category: 'safety', message: `${code}: Runtime capability proof 无法可信验证`,
    retryable: false, cause })
}

function isNodeError(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code
}
