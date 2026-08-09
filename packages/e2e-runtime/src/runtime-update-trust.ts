import { z } from 'zod'

const ExactVersionSchema = z.string().regex(/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/)
const Sha256Schema = z.string().regex(/^sha256:[a-f0-9]{64}$/)
const Sha512HexSchema = z.string().regex(/^[a-f0-9]{128}$/)
const NpmIntegritySchema = z.string().regex(/^sha512-[A-Za-z0-9+/]{86}==$/)
const IsoDateSchema = z.string().datetime({ offset: true })

const SupportedNodeSchema = z.object({
  major: z.union([z.literal(22), z.literal(24)]),
  minimumPatch: ExactVersionSchema,
}).strict().superRefine((value, context) => {
  if (Number(value.minimumPatch.split('.')[0]) !== value.major) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'Node major 与 minimumPatch 不一致' })
  }
})

const SupportedPlatformSchema = z.object({
  platform: z.enum(['darwin', 'linux']),
  arch: z.enum(['arm64', 'x64']),
}).strict()

export const RuntimeTargetCustomSchema = z.object({
  schemaVersion: z.literal('1.0.0'),
  packageName: z.literal('@mutil-skills/e2e-runtime'),
  runtimeVersion: ExactVersionSchema,
  protocolMajor: z.number().int().positive(),
  channel: z.enum(['stable', 'latest']),
  npmIntegrity: NpmIntegritySchema,
  registryUrl: z.string().url().max(2048),
  contentDigest: Sha256Schema,
  executableDigest: Sha256Schema,
  installationDigest: Sha256Schema,
  supportedNode: z.array(SupportedNodeSchema).min(1).max(4),
  supportedPlatforms: z.array(SupportedPlatformSchema).min(1).max(8),
  minimumBootstrapVersion: ExactVersionSchema,
  revoked: z.boolean(),
  revocationReasonCode: z.string().min(1).max(128).regex(/^[A-Z0-9._-]+$/).nullable(),
}).strict().superRefine((value, context) => {
  if (value.revoked !== (value.revocationReasonCode !== null)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: '撤销状态与原因码必须同时存在或同时为空' })
  }
  if (new Set(value.supportedNode.map((item) => item.major)).size !== value.supportedNode.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'supportedNode 不得重复' })
  }
  const platformKeys = value.supportedPlatforms.map((item) => `${item.platform}/${item.arch}`)
  if (new Set(platformKeys).size !== platformKeys.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'supportedPlatforms 不得重复' })
  }
})

export const SignedRuntimeTargetSchema = z.object({
  name: z.string().min(1).max(256).regex(/^[A-Za-z0-9@._/+~-]+$/)
    .refine((value) => !value.includes('..') && !value.startsWith('/'), 'target name 不得越界'),
  length: z.number().int().positive().max(512 * 1024 * 1024),
  hashes: z.object({ sha512: Sha512HexSchema }).strict(),
  custom: RuntimeTargetCustomSchema,
}).strict().superRefine((value, context) => {
  const npmSha512 = value.custom.npmIntegrity.slice('sha512-'.length)
  const tufSha512 = Buffer.from(value.hashes.sha512, 'hex').toString('base64')
  if (npmSha512 !== tufSha512) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'TUF SHA-512 与 npm integrity 必须绑定同一 tarball' })
  }
})

export type SignedRuntimeTarget = z.infer<typeof SignedRuntimeTargetSchema>

const MetadataRoleSchema = z.object({
  version: z.number().int().positive(),
  digest: Sha256Schema,
  expires: IsoDateSchema,
}).strict()

export const TrustedMetadataSetSchema = z.object({
  root: MetadataRoleSchema,
  timestamp: MetadataRoleSchema,
  snapshot: MetadataRoleSchema,
  targets: MetadataRoleSchema,
}).strict()

const RuntimePointerSchema = z.object({
  runtimeVersion: ExactVersionSchema,
  installationDigest: Sha256Schema,
}).strict()

const VerifiedTargetSchema = RuntimePointerSchema.extend({
  contentDigest: Sha256Schema,
  executableDigest: Sha256Schema,
  npmIntegrity: NpmIntegritySchema,
  verifiedAt: IsoDateSchema,
}).strict()

const AuditEntrySchema = z.object({
  at: IsoDateSchema,
  stage: z.enum(['metadata-verified', 'install-failed', 'doctor-failed', 'canary-failed', 'activated']),
  resultCode: z.string().min(1).max(128).regex(/^[A-Z0-9._-]+$/),
  runtimeVersion: ExactVersionSchema.nullable(),
  installationDigest: Sha256Schema.nullable(),
}).strict()

export const RuntimeUpdateStateSchema = z.object({
  schemaVersion: z.literal('1.0.0'),
  highwaterWallClock: IsoDateSchema,
  metadata: TrustedMetadataSetSchema,
  verifiedTargets: z.array(VerifiedTargetSchema).max(64),
  newRunDefault: RuntimePointerSchema.nullable(),
  lkg: RuntimePointerSchema.nullable(),
  audit: z.array(AuditEntrySchema).max(1024),
}).strict()

export type TrustedMetadataSet = z.infer<typeof TrustedMetadataSetSchema>
export type RuntimeUpdateState = z.infer<typeof RuntimeUpdateStateSchema>
export type RuntimeTargetEnvironment = {
  channel: 'stable' | 'latest'
  nodeVersion: string
  platform: 'darwin' | 'linux'
  arch: 'arm64' | 'x64'
  protocolMajor: number
  bootstrapVersion: string
  allowedRegistryOrigins: readonly string[]
}

export class RuntimeUpdateError extends Error {
  readonly code: string
  constructor(code: string, message: string, options?: ErrorOptions) {
    super(`${code}: ${message}`, options)
    this.name = 'RuntimeUpdateError'
    this.code = code
  }
}

export function validateRuntimeTarget(
  candidate: unknown,
  environment: RuntimeTargetEnvironment,
): SignedRuntimeTarget {
  const parsed = SignedRuntimeTargetSchema.safeParse(candidate)
  if (!parsed.success) fail('E2E_RUNTIME_UPDATE_TARGET_INVALID', '签名 target custom 身份无效')
  const target = parsed.data
  if (target.custom.revoked) fail(
    'E2E_RUNTIME_UPDATE_TARGET_REVOKED',
    `Runtime target 已撤销：${target.custom.revocationReasonCode ?? 'UNKNOWN'}`,
  )
  if (target.custom.channel !== environment.channel) fail('E2E_RUNTIME_UPDATE_CHANNEL_MISMATCH', 'target channel 不匹配')
  if (target.custom.protocolMajor !== environment.protocolMajor) {
    fail('E2E_RUNTIME_UPDATE_PROTOCOL_UNSUPPORTED', 'Runtime protocol major 不兼容')
  }
  if (compareVersions(environment.bootstrapVersion, target.custom.minimumBootstrapVersion) < 0) {
    fail('E2E_RUNTIME_UPDATE_BOOTSTRAP_UNSUPPORTED', 'Bootstrap 版本低于 target 最低要求')
  }
  const node = parseVersion(environment.nodeVersion, 'E2E_RUNTIME_UPDATE_NODE_UNSUPPORTED')
  const supportedNode = target.custom.supportedNode.find((candidateNode) => candidateNode.major === node[0])
  if (supportedNode === undefined || compareVersions(environment.nodeVersion, supportedNode.minimumPatch) < 0) {
    fail('E2E_RUNTIME_UPDATE_NODE_UNSUPPORTED', '当前 Node 未进入签名支持矩阵')
  }
  if (!target.custom.supportedPlatforms.some(
    (candidatePlatform) => candidatePlatform.platform === environment.platform && candidatePlatform.arch === environment.arch,
  )) fail('E2E_RUNTIME_UPDATE_PLATFORM_UNSUPPORTED', '当前 OS/arch 未进入签名支持矩阵')

  let registryUrl: URL
  try {
    registryUrl = new URL(target.custom.registryUrl)
  } catch {
    fail('E2E_RUNTIME_UPDATE_ORIGIN_DENIED', 'registry URL 无效')
  }
  if (registryUrl.protocol !== 'https:' || registryUrl.username !== '' || registryUrl.password !== ''
    || registryUrl.hash !== '' || !environment.allowedRegistryOrigins.includes(registryUrl.origin)) {
    fail('E2E_RUNTIME_UPDATE_ORIGIN_DENIED', 'registry origin 不在允许列表')
  }
  return target
}

export function advanceTrustedMetadata(
  previous: RuntimeUpdateState | undefined,
  candidate: unknown,
  updateStart: Date,
): RuntimeUpdateState {
  const parsedCandidate = TrustedMetadataSetSchema.safeParse(candidate)
  if (!parsedCandidate.success || !Number.isFinite(updateStart.getTime())) {
    fail('E2E_RUNTIME_UPDATE_METADATA_INVALID', 'TUF metadata 高水位输入无效')
  }
  const current = previous === undefined ? undefined : parseState(previous)
  if (current !== undefined
    && updateStart.getTime() < new Date(current.highwaterWallClock).getTime() - 5 * 60_000) {
    fail('E2E_RUNTIME_UPDATE_CLOCK_ROLLBACK', '本机时钟相对可信高水位倒退超过五分钟')
  }
  for (const role of ['root', 'timestamp', 'snapshot', 'targets'] as const) {
    const nextRole = parsedCandidate.data[role]
    if (new Date(nextRole.expires).getTime() <= updateStart.getTime()) {
      fail('E2E_RUNTIME_UPDATE_METADATA_EXPIRED', `${role} metadata 已过期`)
    }
    const previousRole = current?.metadata[role]
    if (previousRole !== undefined && nextRole.version < previousRole.version) {
      fail('E2E_RUNTIME_UPDATE_METADATA_ROLLBACK', `${role} metadata 版本回滚`)
    }
    if (previousRole !== undefined && nextRole.version === previousRole.version
      && nextRole.digest !== previousRole.digest) {
      fail('E2E_RUNTIME_UPDATE_METADATA_MIX_AND_MATCH', `${role} 同版本摘要发生混搭`)
    }
  }
  const nextClock = current === undefined
    ? updateStart.toISOString()
    : new Date(Math.max(updateStart.getTime(), new Date(current.highwaterWallClock).getTime())).toISOString()
  return {
    schemaVersion: '1.0.0',
    highwaterWallClock: nextClock,
    metadata: parsedCandidate.data,
    verifiedTargets: current?.verifiedTargets ?? [],
    newRunDefault: current?.newRunDefault ?? null,
    lkg: current?.lkg ?? null,
    audit: current?.audit ?? [],
  }
}

export interface InstalledRuntimeIdentity {
  runtimeVersion: string
  installationDigest: string
  contentDigest: string
  executableDigest: string
  npmIntegrity: string
}

export interface StableRuntimeUpdateOptions {
  enabled: boolean
  trustedRootPath: string
  metadataBaseUrl: string
  now: () => Date
  environment: RuntimeTargetEnvironment
  loadState: () => Promise<RuntimeUpdateState | undefined>
  saveState: (state: RuntimeUpdateState) => Promise<void>
  refresh: () => Promise<{ metadata: TrustedMetadataSet; target: SignedRuntimeTarget }>
  install: (target: SignedRuntimeTarget) => Promise<InstalledRuntimeIdentity>
  doctor: (installed: InstalledRuntimeIdentity) => Promise<void>
  canary: (installed: InstalledRuntimeIdentity) => Promise<void>
}

export async function applyStableRuntimeUpdate(options: StableRuntimeUpdateOptions): Promise<{
  status: 'activated'
  target: SignedRuntimeTarget
  state: RuntimeUpdateState
}> {
  assertStableConfigured(options)
  const startedAt = options.now()
  const previous = await options.loadState()
  const refreshed = await options.refresh()
  let state = advanceTrustedMetadata(previous, refreshed.metadata, startedAt)
  // 即使 target 被撤销或身份无效，也必须先保留已由 TUF 验签的角色高水位，
  // 否则下一次请求可能接受更旧、尚未包含撤销信息的 metadata。
  await options.saveState(state)
  const signedTarget = validateRuntimeTarget(refreshed.target, { ...options.environment, channel: 'stable' })
  state = appendAudit(state, startedAt, 'metadata-verified', 'OK', signedTarget)
  await options.saveState(state)

  let installed: InstalledRuntimeIdentity
  try {
    installed = await options.install(signedTarget)
    assertInstalledIdentity(signedTarget, installed)
  } catch (cause) {
    state = appendAudit(state, options.now(), 'install-failed', 'INSTALL_FAILED', signedTarget)
    await options.saveState(state)
    throw new RuntimeUpdateError('E2E_RUNTIME_UPDATE_INSTALL_FAILED', '签名 Runtime 安装或身份验证失败', { cause })
  }
  try {
    await options.doctor(installed)
  } catch (cause) {
    state = appendAudit(state, options.now(), 'doctor-failed', 'DOCTOR_FAILED', signedTarget)
    await options.saveState(state)
    throw new RuntimeUpdateError('E2E_RUNTIME_UPDATE_DOCTOR_FAILED', '新 Runtime doctor 未通过', { cause })
  }
  try {
    await options.canary(installed)
  } catch (cause) {
    state = appendAudit(state, options.now(), 'canary-failed', 'CANARY_FAILED', signedTarget)
    await options.saveState(state)
    throw new RuntimeUpdateError('E2E_RUNTIME_UPDATE_CANARY_FAILED', '新 Runtime canary 未通过', { cause })
  }

  const previousDefault = state.newRunDefault
  const verifiedTarget = {
    runtimeVersion: installed.runtimeVersion,
    installationDigest: installed.installationDigest,
    contentDigest: installed.contentDigest,
    executableDigest: installed.executableDigest,
    npmIntegrity: installed.npmIntegrity,
    verifiedAt: options.now().toISOString(),
  }
  state = {
    ...state,
    verifiedTargets: [
      ...state.verifiedTargets.filter((item) => item.installationDigest !== installed.installationDigest),
      verifiedTarget,
    ].slice(-64),
    lkg: previousDefault,
    newRunDefault: {
      runtimeVersion: installed.runtimeVersion,
      installationDigest: installed.installationDigest,
    },
  }
  state = appendAudit(state, options.now(), 'activated', 'OK', signedTarget)
  state = parseState(state)
  await options.saveState(state)
  return { status: 'activated', target: signedTarget, state }
}

function assertStableConfigured(options: StableRuntimeUpdateOptions): void {
  if (!options.enabled) fail('E2E_RUNTIME_UPDATE_DISABLED', 'stable 在线更新未启用')
  if (!options.trustedRootPath.startsWith('/')) {
    fail('E2E_RUNTIME_UPDATE_TRUST_ROOT_MISSING', '必须配置经审核的绝对 trusted root 路径')
  }
  let metadataUrl: URL
  try {
    metadataUrl = new URL(options.metadataBaseUrl)
  } catch {
    fail('E2E_RUNTIME_UPDATE_METADATA_ORIGIN_INVALID', 'metadata origin 无效')
  }
  if (metadataUrl.protocol !== 'https:' || metadataUrl.username !== '' || metadataUrl.password !== '') {
    fail('E2E_RUNTIME_UPDATE_METADATA_ORIGIN_INVALID', 'metadata origin 必须是无凭证 HTTPS URL')
  }
}

function assertInstalledIdentity(target: SignedRuntimeTarget, installed: InstalledRuntimeIdentity): void {
  const expected = target.custom
  if (installed.runtimeVersion !== expected.runtimeVersion
    || installed.installationDigest !== expected.installationDigest
    || installed.contentDigest !== expected.contentDigest
    || installed.executableDigest !== expected.executableDigest
    || installed.npmIntegrity !== expected.npmIntegrity) {
    fail('E2E_RUNTIME_UPDATE_INSTALLED_IDENTITY_MISMATCH', '安装闭包与签名 target 身份不一致')
  }
}

function appendAudit(
  state: RuntimeUpdateState,
  at: Date,
  stage: RuntimeUpdateState['audit'][number]['stage'],
  resultCode: string,
  target: SignedRuntimeTarget,
): RuntimeUpdateState {
  return parseState({
    ...state,
    audit: [...state.audit, {
      at: at.toISOString(), stage, resultCode,
      runtimeVersion: target.custom.runtimeVersion,
      installationDigest: target.custom.installationDigest,
    }].slice(-1024),
  })
}

function parseState(candidate: unknown): RuntimeUpdateState {
  const parsed = RuntimeUpdateStateSchema.safeParse(candidate)
  if (!parsed.success) fail('E2E_RUNTIME_UPDATE_STATE_INVALID', 'Runtime update state 无效')
  return parsed.data
}

function compareVersions(left: string, right: string): number {
  const leftParts = parseVersion(left, 'E2E_RUNTIME_UPDATE_VERSION_INVALID')
  const rightParts = parseVersion(right, 'E2E_RUNTIME_UPDATE_VERSION_INVALID')
  for (let index = 0; index < 3; index += 1) {
    if (leftParts[index] !== rightParts[index]) return leftParts[index]! - rightParts[index]!
  }
  return 0
}

function parseVersion(version: string, code: string): [number, number, number] {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(version)
  if (match === null) fail(code, '版本不是精确稳定 SemVer')
  return [Number(match[1]), Number(match[2]), Number(match[3])]
}

function fail(code: string, message: string): never {
  throw new RuntimeUpdateError(code, message)
}
