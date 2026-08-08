import { canonicalizeJson, digestText } from '@mutil-skills/e2e-contracts'
import { readdir } from 'node:fs/promises'
import { z } from 'zod'
import { runtimeLayout } from './runtime-layout.js'
import { withRuntimeInstallLock } from './runtime-installer.js'
import {
  isExactRuntimeVersion,
  runtimeError,
  verifyCurrentRuntimeInstallation,
  verifyInstalledRuntimeVersion,
  verifyRuntimeRoot,
  type VerifiedRuntimeVersion,
} from './runtime-manifest.js'
import type { RuntimeInstallation } from './runtime-discovery.js'

const DigestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/)
const ExactVersionSchema = z.string().refine(isExactRuntimeVersion, 'Runtime 版本必须是精确稳定 SemVer')

export const RuntimeResolverPolicySchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('offline') }).strict(),
  z.object({ mode: z.literal('stable') }).strict(),
  z.object({
    mode: z.literal('pinned'),
    version: ExactVersionSchema,
    installationDigest: DigestSchema.optional(),
  }).strict(),
])

export interface ExistingRunRuntimeBinding {
  runId: string
  installationDigest: string
}

export interface ResolveRuntimeInstallationOptions {
  homeDir: string
  policy: RuntimeResolverPolicy
  existingRun?: ExistingRunRuntimeBinding
  stableResolver?: StableRuntimeResolver
}

export interface StableRuntimeResolver {
  (): Promise<{
    runtimeVersion: string
    installationDigest: string
    revocationStatus: 'revocation-checked'
  }>
}

export interface RuntimeResolution {
  selectionKind: 'new-run' | 'existing-run'
  policyMode: 'offline' | 'pinned' | 'stable' | 'run-bound'
  revocationStatus: 'revocation-checked' | 'offline-unchecked' | 'metadata-expired'
  installation: RuntimeInstallation
  runBinding: { runtimeVersion: string; installationDigest: string }
  selectionDigest: string
}

export type RuntimeResolverPolicy = z.infer<typeof RuntimeResolverPolicySchema>

/**
 * Phase 5/6 Resolver：offline/pinned 只选择本地 closure；stable 只委托经批准的签名更新服务。
 * 已有 Run 的 installation digest 优先于任何新 Run policy。
 */
export async function resolveRuntimeInstallation(
  options: ResolveRuntimeInstallationOptions,
): Promise<RuntimeResolution> {
  return await withResolvedRuntimeInstallation(options, async (runtimeResolution) => runtimeResolution)
}

/**
 * 在 Runtime 安装锁内完成选择，并把解析结果交给调用方持久化到新 Run。
 * 调用方必须在回调返回前完成 durable binding；这样卸载/GC 无法进入选择与固化之间的窗口。
 */
export async function withResolvedRuntimeInstallation<T>(
  options: ResolveRuntimeInstallationOptions,
  bind: (runtimeResolution: RuntimeResolution) => Promise<T>,
): Promise<T> {
  const policy = parsePolicy(options.policy)
  const existingRun = parseExistingRun(options.existingRun)
  const layout = runtimeLayout(options.homeDir)
  await verifyRuntimeRoot(layout)
  if (existingRun === undefined && policy.mode === 'stable') {
    if (options.stableResolver === undefined) runtimeError(
      'E2E_RUNTIME_STABLE_UPDATE_UNAVAILABLE',
      'stable 签名更新服务未配置；不得静默降级为 offline',
      'environment',
    )
    const candidate = await options.stableResolver()
    assertStableCandidate(candidate)
    return await withRuntimeInstallLock(layout, async () => {
      await verifyRuntimeRoot(layout)
      const verified = await verifyInstalledRuntimeVersion(layout, candidate.runtimeVersion)
      if (verified.manifest.installationDigest !== candidate.installationDigest) runtimeError(
        'E2E_RUNTIME_STABLE_DIGEST_MISMATCH',
        'stable 更新结果与本地已验证 closure 摘要不一致',
      )
      return await bind(resolution('new-run', 'stable', verified, undefined, candidate.revocationStatus))
    })
  }
  return await withRuntimeInstallLock(layout, async () => {
    await verifyRuntimeRoot(layout)
    const selected = await resolveVerifiedRuntimeInstallation(layout, policy, existingRun)
    return await bind(selected)
  })
}

async function resolveVerifiedRuntimeInstallation(
  layout: ReturnType<typeof runtimeLayout>,
  policy: RuntimeResolverPolicy,
  existingRun: ExistingRunRuntimeBinding | undefined,
): Promise<RuntimeResolution> {
  if (existingRun !== undefined) {
    const installation = await findInstallationByDigest(layout, existingRun.installationDigest)
    if (installation === undefined) runtimeError(
      'E2E_RUNTIME_RUN_INSTALLATION_UNAVAILABLE',
      `Run ${existingRun.runId} 绑定的 Runtime closure 不存在或未通过验证`,
      'environment',
    )
    return resolution('existing-run', 'run-bound', installation, existingRun.runId, 'offline-unchecked')
  }
  if (policy.mode === 'offline') {
    const { installation } = await verifyCurrentRuntimeInstallation(layout)
    return resolution('new-run', 'offline', installation, undefined, 'offline-unchecked')
  }
  if (policy.mode === 'stable') runtimeError(
    'E2E_RUNTIME_STABLE_UPDATE_UNAVAILABLE',
    'stable 新 Run 必须先通过签名更新服务',
    'internal',
  )
  const installation = await verifyInstalledRuntimeVersion(layout, policy.version)
  if (policy.installationDigest !== undefined
    && installation.manifest.installationDigest !== policy.installationDigest) {
    runtimeError('E2E_RUNTIME_PINNED_DIGEST_MISMATCH', 'pinned Runtime 版本与 installation digest 不一致')
  }
  return resolution('new-run', 'pinned', installation, undefined, 'offline-unchecked')
}

function parsePolicy(candidate: unknown): RuntimeResolverPolicy {
  const parsed = RuntimeResolverPolicySchema.safeParse(candidate)
  if (!parsed.success) runtimeError(
    'E2E_RUNTIME_RESOLVER_POLICY_INVALID',
    '只接受 offline、stable 或精确 pinned 策略；latest 尚未批准',
    'input',
  )
  return parsed.data
}

function parseExistingRun(candidate: unknown): ExistingRunRuntimeBinding | undefined {
  if (candidate === undefined) return undefined
  const parsed = z.object({
    runId: z.string().min(1).max(256).regex(/^[A-Za-z0-9._:-]+$/),
    installationDigest: DigestSchema,
  }).strict().safeParse(candidate)
  if (!parsed.success) runtimeError('E2E_RUNTIME_RUN_BINDING_INVALID', '已有 Run 的 Runtime 绑定无效', 'input')
  return parsed.data
}

async function findInstallationByDigest(
  layout: ReturnType<typeof runtimeLayout>,
  installationDigest: string,
): Promise<VerifiedRuntimeVersion | undefined> {
  const entries = await readdir(layout.versions, { withFileTypes: true })
  const matches: VerifiedRuntimeVersion[] = []
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.isDirectory() || !isExactRuntimeVersion(entry.name)) continue
    const verified = await verifyInstalledRuntimeVersion(layout, entry.name)
    if (verified.manifest.installationDigest === installationDigest) matches.push(verified)
  }
  if (matches.length > 1) runtimeError(
    'E2E_RUNTIME_INSTALLATION_DIGEST_AMBIGUOUS',
    '同一 installation digest 对应多个已安装 Runtime version',
  )
  return matches[0]
}

function resolution(
  selectionKind: RuntimeResolution['selectionKind'],
  policyMode: RuntimeResolution['policyMode'],
  verified: VerifiedRuntimeVersion,
  runId?: string,
  revocationStatus: RuntimeResolution['revocationStatus'] = 'offline-unchecked',
): RuntimeResolution {
  const installation: RuntimeInstallation = {
    version: verified.version,
    protocolMajor: 1,
    versionRoot: verified.versionRoot,
    entrypoint: verified.entrypoint,
    installationDigest: verified.manifest.installationDigest,
    sourceRepositoryIndependent: true,
  }
  const body = {
    schemaVersion: '1.0.0', selectionKind, policyMode,
    runtimeVersion: installation.version, revocationStatus,
    installationDigest: installation.installationDigest,
    ...(runId === undefined ? {} : { runId }),
  }
  return {
    selectionKind, policyMode, installation, revocationStatus,
    runBinding: {
      runtimeVersion: installation.version,
      installationDigest: installation.installationDigest,
    },
    selectionDigest: digestText('runtime-resolution/v1', canonicalizeJson(body)),
  }
}

function assertStableCandidate(candidate: unknown): asserts candidate is Awaited<ReturnType<StableRuntimeResolver>> {
  const parsed = z.object({
    runtimeVersion: ExactVersionSchema,
    installationDigest: DigestSchema,
    revocationStatus: z.literal('revocation-checked'),
  }).strict().safeParse(candidate)
  if (!parsed.success) runtimeError(
    'E2E_RUNTIME_STABLE_RESULT_INVALID',
    'stable 更新服务返回了无效或未完成撤销检查的结果',
  )
}
