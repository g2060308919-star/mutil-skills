import { canonicalizeJson } from '@mutil-skills/e2e-contracts'
import { BaseFetcher, Updater, type TargetFile, type UpdaterOptions } from 'tuf-js'
import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { chmod, lstat, mkdir, open, readFile, realpath, rename, unlink } from 'node:fs/promises'
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { z } from 'zod'
import { runtimeLayout } from './runtime-layout.js'
import { currentUid } from './runtime-manifest.js'
import {
  RuntimeUpdateError,
  RuntimeUpdateStateSchema,
  SignedRuntimeTargetSchema,
  type RuntimeUpdateState,
  type SignedRuntimeTarget,
  type TrustedMetadataSet,
} from './runtime-update-trust.js'
import {
  issueVerifiedTufGovernance,
  type VerifiedTufGovernance,
} from './stable-activation-audit.js'

const MetadataEnvelopeSchema = z.object({
  signed: z.object({
    _type: z.enum(['root', 'timestamp', 'snapshot', 'targets']),
    version: z.number().int().positive(),
    expires: z.string().datetime({ offset: true }),
  }).passthrough(),
}).passthrough()

const RootGovernanceEnvelopeSchema = z.object({
  signed: z.object({
    _type: z.literal('root'),
    keys: z.record(z.object({
      keytype: z.string().min(1).max(64),
      scheme: z.string().min(1).max(128),
      keyval: z.object({ public: z.string().min(1).max(16_384) }).strict(),
    }).strict()),
    roles: z.object({
      root: z.object({ keyids: z.array(z.string()).length(3), threshold: z.literal(2) }).strict(),
      targets: z.object({ keyids: z.array(z.string()).length(3), threshold: z.literal(2) }).strict(),
    }).passthrough(),
  }).passthrough(),
}).passthrough()

export interface TufUpdaterLike {
  refresh(): Promise<void>
  getTargetInfo(path: string): Promise<{
    path: string
    length: number
    hashes: Record<string, string>
    custom: Record<string, unknown>
  } | undefined>
  downloadTarget(target: unknown, filePath?: string, targetBaseUrl?: string): Promise<string>
}

export type TufUpdaterFactory = (options: Record<string, unknown>) => TufUpdaterLike

type FetchImplementation = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

export class BoundedOriginFetcher extends BaseFetcher {
  readonly #allowedOrigins: ReadonlySet<string>
  readonly #fetch: FetchImplementation

  constructor(allowedOrigins: readonly string[], fetchImplementation: FetchImplementation = globalThis.fetch) {
    super()
    this.#allowedOrigins = new Set(allowedOrigins.map((origin) => secureOrigin(origin)))
    this.#fetch = fetchImplementation
  }

  async fetch(candidate: string): Promise<ReadableStream<Uint8Array<ArrayBuffer>>> {
    let url = new URL(candidate)
    for (let redirects = 0; ; redirects += 1) {
      if (url.protocol !== 'https:' || !this.#allowedOrigins.has(url.origin)
        || url.username !== '' || url.password !== '' || url.hash !== '') {
        throw updateError('E2E_RUNTIME_UPDATE_FETCH_ORIGIN_DENIED', '更新请求或重定向 origin 不在允许列表')
      }
      const response = await this.#fetch(url, {
        method: 'GET', redirect: 'manual', credentials: 'omit', cache: 'no-store',
        signal: AbortSignal.timeout(30_000),
        headers: { accept: 'application/octet-stream, application/json' },
      }).catch((cause: unknown) => {
        throw updateError('E2E_RUNTIME_UPDATE_FETCH_FAILED', '更新网络请求失败', cause)
      })
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location')
        if (location === null) throw updateError('E2E_RUNTIME_UPDATE_FETCH_REDIRECT_INVALID', '更新重定向缺少 location')
        if (redirects >= 3) throw updateError('E2E_RUNTIME_UPDATE_FETCH_REDIRECT_LIMIT', '更新重定向超过三次')
        url = new URL(location, url)
        continue
      }
      if (!response.ok || response.body === null) {
        throw updateError('E2E_RUNTIME_UPDATE_FETCH_HTTP_FAILED', `更新服务器返回 HTTP ${response.status}`)
      }
      return response.body as ReadableStream<Uint8Array<ArrayBuffer>>
    }
  }
}

export interface TufRuntimeUpdateClientOptions {
  homeDir: string
  trustedRootPath: string
  metadataBaseUrl: string
  targetBaseUrl: string
  targetPath: string
  updaterFactory?: TufUpdaterFactory
}

/**
 * 将官方 tuf-js 的已验证结果投影为 Runtime 的封闭 target/state 模型。
 * 该类不解释签名、不重排 TUF workflow，也不接受调用方提供的“已验证”布尔值。
 */
export class TufRuntimeUpdateClient {
  readonly #options: TufRuntimeUpdateClientOptions
  #updater: TufUpdaterLike | undefined
  #targetInfo: Awaited<ReturnType<TufUpdaterLike['getTargetInfo']>>
  #target: SignedRuntimeTarget | undefined
  #targetDir: string | undefined

  constructor(options: TufRuntimeUpdateClientOptions) {
    this.#options = options
  }

  async refresh(): Promise<{
    metadata: TrustedMetadataSet; target: SignedRuntimeTarget; governance: VerifiedTufGovernance
  }> {
    const config = validateClientConfig(this.#options)
    const roots = updateRoots(this.#options.homeDir)
    await ensurePrivateDirectory(roots.root)
    await ensurePrivateDirectory(roots.metadata)
    await ensurePrivateDirectory(roots.targets)
    await ensureBootstrapRoot(this.#options.trustedRootPath, join(roots.metadata, 'root.json'))
    const updaterOptions: UpdaterOptions = {
      metadataDir: roots.metadata,
      metadataBaseUrl: config.metadataBaseUrl,
      targetDir: roots.targets,
      targetBaseUrl: config.targetBaseUrl,
      forceCache: false,
      fetcher: new BoundedOriginFetcher([
        new URL(config.metadataBaseUrl).origin,
        new URL(config.targetBaseUrl).origin,
      ]),
      config: {
        maxRootRotations: 32,
        maxDelegations: 8,
        rootMaxLength: 512_000,
        timestampMaxLength: 16_384,
        snapshotMaxLength: 2_000_000,
        targetsMaxLength: 5_000_000,
        prefixTargetsWithHash: true,
        fetchTimeout: 30_000,
        fetchRetries: 2,
        userAgent: '@mutil-skills/e2e-runtime',
      },
    }
    const updater = this.#options.updaterFactory === undefined
      ? new Updater(updaterOptions) as unknown as TufUpdaterLike
      : this.#options.updaterFactory(updaterOptions as unknown as Record<string, unknown>)
    try {
      await updater.refresh()
    } catch (cause) {
      throw updateError('E2E_RUNTIME_UPDATE_TUF_REFRESH_FAILED', 'TUF metadata 刷新或验签失败', cause)
    }
    await privatizeMetadataFiles(roots.metadata)
    const targetInfo = await updater.getTargetInfo(config.targetPath).catch((cause: unknown) => {
      throw updateError('E2E_RUNTIME_UPDATE_TUF_TARGET_FAILED', 'TUF target 查询失败', cause)
    })
    if (targetInfo === undefined) throw updateError('E2E_RUNTIME_UPDATE_TUF_TARGET_MISSING', '签名 metadata 中没有指定 Runtime target')
    const parsedTarget = SignedRuntimeTargetSchema.safeParse({
      name: targetInfo.path,
      length: targetInfo.length,
      hashes: { sha512: targetInfo.hashes.sha512 },
      custom: targetInfo.custom,
    })
    if (!parsedTarget.success) {
      throw updateError('E2E_RUNTIME_UPDATE_TARGET_INVALID', 'TUF target 缺少严格 Runtime 身份', parsedTarget.error)
    }
    const expectedTargetUrl = new URL(targetInfo.path, config.targetBaseUrl).href
    if (targetInfo.path !== config.targetPath || new URL(parsedTarget.data.custom.registryUrl).href !== expectedTargetUrl) {
      throw updateError('E2E_RUNTIME_UPDATE_TARGET_URL_MISMATCH', '签名 registry URL 与实际 TUF target URL 不一致')
    }
    const metadata = await readTrustedMetadataSet(roots.metadata)
    const governance = await readVerifiedTufGovernance(roots.metadata, metadata.root.digest)
    this.#updater = updater
    this.#targetInfo = targetInfo
    this.#target = parsedTarget.data
    this.#targetDir = roots.targets
    return { metadata, target: parsedTarget.data, governance }
  }

  async downloadTarget(target: SignedRuntimeTarget): Promise<string> {
    if (this.#updater === undefined || this.#targetInfo === undefined || this.#target === undefined
      || this.#targetDir === undefined || canonicalizeJson(target) !== canonicalizeJson(this.#target)) {
      throw updateError('E2E_RUNTIME_UPDATE_REFRESH_REQUIRED', '下载前必须在同一客户端完成目标 refresh')
    }
    const destination = join(this.#targetDir, basename(target.name))
    try {
      const downloaded = await this.#updater.downloadTarget(
        this.#targetInfo as unknown as TargetFile,
        destination,
        this.#options.targetBaseUrl,
      )
      await privatizeDownloadedTarget(downloaded, this.#targetDir, target.length)
      return downloaded
    } catch (cause) {
      throw updateError('E2E_RUNTIME_UPDATE_TARGET_DOWNLOAD_FAILED', 'TUF target 下载或长度/哈希验证失败', cause)
    }
  }
}

export async function readRuntimeUpdateState(homeDir: string): Promise<RuntimeUpdateState | undefined> {
  const target = join(runtimeLayout(homeDir).state, 'runtime-update.json')
  let handle
  try {
    handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW)
  } catch (cause) {
    if (isNodeError(cause, 'ENOENT')) return undefined
    throw updateError('E2E_RUNTIME_UPDATE_STATE_UNSAFE', 'update state 不是安全普通文件', cause)
  }
  try {
    const metadata = await handle.stat()
    if (!metadata.isFile() || metadata.uid !== currentUid() || metadata.nlink !== 1
      || (metadata.mode & 0o777) !== 0o600 || metadata.size > 1024 * 1024) {
      throw updateError('E2E_RUNTIME_UPDATE_STATE_UNSAFE', 'update state 必须是当前用户独占的 0600 普通文件')
    }
    const parsed = RuntimeUpdateStateSchema.safeParse(JSON.parse(await handle.readFile('utf8')))
    if (!parsed.success) throw updateError('E2E_RUNTIME_UPDATE_STATE_INVALID', 'update state schema 无效', parsed.error)
    return parsed.data
  } catch (cause) {
    if (cause instanceof RuntimeUpdateError) throw cause
    throw updateError('E2E_RUNTIME_UPDATE_STATE_INVALID', 'update state 无法解析', cause)
  } finally {
    await handle.close()
  }
}

export async function writeRuntimeUpdateState(homeDir: string, candidate: RuntimeUpdateState): Promise<void> {
  const state = RuntimeUpdateStateSchema.safeParse(candidate)
  if (!state.success) throw updateError('E2E_RUNTIME_UPDATE_STATE_INVALID', '拒绝保存无效 update state', state.error)
  const directory = runtimeLayout(homeDir).state
  await ensurePrivateDirectory(directory)
  const target = join(directory, 'runtime-update.json')
  const temporary = join(directory, `.runtime-update-${randomUUID()}.tmp`)
  let handle
  try {
    handle = await open(temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
    await handle.writeFile(`${canonicalizeJson(state.data)}\n`, 'utf8')
    await handle.sync()
    await handle.close(); handle = undefined
    await rename(temporary, target)
    await chmod(target, 0o600)
    const directoryHandle = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
    try { await directoryHandle.sync() } finally { await directoryHandle.close() }
  } finally {
    await handle?.close().catch(() => undefined)
    await unlink(temporary).catch((cause) => { if (!isNodeError(cause, 'ENOENT')) throw cause })
  }
}

async function readTrustedMetadataSet(metadataDir: string): Promise<TrustedMetadataSet> {
  const roles = {} as Record<string, { version: number; digest: string; expires: string }>
  for (const role of ['root', 'timestamp', 'snapshot', 'targets'] as const) {
    const bytes = await readBoundedFile(join(metadataDir, `${role}.json`), metadataLimit(role))
    let parsed
    try { parsed = MetadataEnvelopeSchema.parse(JSON.parse(bytes.toString('utf8'))) } catch (cause) {
      throw updateError('E2E_RUNTIME_UPDATE_METADATA_INVALID', `${role} metadata 无法严格投影`, cause)
    }
    if (parsed.signed._type !== role) throw updateError('E2E_RUNTIME_UPDATE_METADATA_INVALID', `${role} metadata role 混搭`)
    roles[role] = {
      version: parsed.signed.version,
      digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
      expires: new Date(parsed.signed.expires).toISOString(),
    }
  }
  return roles as TrustedMetadataSet
}

async function readVerifiedTufGovernance(
  metadataDir: string,
  rootMetadataDigest: string,
): Promise<VerifiedTufGovernance> {
  let parsed: z.infer<typeof RootGovernanceEnvelopeSchema>
  try {
    parsed = RootGovernanceEnvelopeSchema.parse(
      JSON.parse((await readBoundedFile(join(metadataDir, 'root.json'), metadataLimit('root'))).toString('utf8')),
    )
  } catch (cause) {
    throw updateError('E2E_RUNTIME_UPDATE_ROOT_GOVERNANCE_INVALID', '已验证 root 不满足 2-of-3 治理约束', cause)
  }
  const available = new Set(Object.keys(parsed.signed.keys))
  for (const role of [parsed.signed.roles.root, parsed.signed.roles.targets]) {
    if (new Set(role.keyids).size !== role.keyids.length || role.keyids.some((keyId) => !available.has(keyId))) {
      throw updateError('E2E_RUNTIME_UPDATE_ROOT_GOVERNANCE_INVALID', 'root/targets role key IDs 无效')
    }
  }
  return issueVerifiedTufGovernance({
    root: { keyIds: parsed.signed.roles.root.keyids, threshold: parsed.signed.roles.root.threshold },
    targets: { keyIds: parsed.signed.roles.targets.keyids, threshold: parsed.signed.roles.targets.threshold },
    rootMetadataDigest,
  })
}

async function ensureBootstrapRoot(source: string, target: string): Promise<void> {
  try {
    const existing = await readBoundedFile(target, 512_000)
    if (existing.byteLength === 0) throw updateError('E2E_RUNTIME_UPDATE_TRUST_ROOT_INVALID', 'cached root 为空')
    return
  } catch (cause) {
    if (!(isNodeError(cause, 'ENOENT'))) throw cause
  }
  const bytes = await readBoundedFile(source, 512_000)
  let handle
  try {
    handle = await open(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
    await handle.writeFile(bytes)
    await handle.sync()
  } catch (cause) {
    if (!isNodeError(cause, 'EEXIST')) throw updateError('E2E_RUNTIME_UPDATE_TRUST_ROOT_INVALID', '无法引导 trusted root', cause)
  } finally { await handle?.close() }
}

async function readBoundedFile(path: string, maxLength: number): Promise<Buffer> {
  let handle
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
    const stat = await handle.stat()
    if (!stat.isFile() || stat.nlink !== 1 || stat.size <= 0 || stat.size > maxLength) {
      throw updateError('E2E_RUNTIME_UPDATE_FILE_UNSAFE', '更新文件不是有限长独占普通文件')
    }
    return await handle.readFile()
  } finally { await handle?.close() }
}

async function ensurePrivateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 })
  const metadata = await lstat(path)
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || metadata.uid !== currentUid()) {
    throw updateError('E2E_RUNTIME_UPDATE_DIRECTORY_UNSAFE', '更新目录必须是当前用户所有的真实目录')
  }
  if ((metadata.mode & 0o777) !== 0o700) await chmod(path, 0o700)
}

async function privatizeMetadataFiles(directory: string): Promise<void> {
  for (const role of ['root', 'timestamp', 'snapshot', 'targets']) {
    const path = join(directory, `${role}.json`)
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
    try {
      const metadata = await handle.stat()
      if (!metadata.isFile() || metadata.uid !== currentUid() || metadata.nlink !== 1
        || metadata.size <= 0 || metadata.size > metadataLimit(role as 'root' | 'timestamp' | 'snapshot' | 'targets')) {
        throw updateError('E2E_RUNTIME_UPDATE_METADATA_UNSAFE', `${role} metadata 不是当前用户独占的有限长普通文件`)
      }
      await handle.chmod(0o600)
    } finally { await handle.close() }
  }
}

async function privatizeDownloadedTarget(path: string, targetDirectory: string, expectedLength: number): Promise<void> {
  if (!isAbsolute(path)) throw updateError('E2E_RUNTIME_UPDATE_TARGET_FILE_UNSAFE', 'TUF target 下载路径不是绝对路径')
  await realDirectory(targetDirectory)
  const directoryRoot = resolve(targetDirectory)
  const absolutePath = resolve(path)
  const pathRelative = relative(directoryRoot, absolutePath)
  if (pathRelative === '' || pathRelative === '..' || pathRelative.startsWith(`..${sep}`) || isAbsolute(pathRelative)) {
    throw updateError('E2E_RUNTIME_UPDATE_TARGET_FILE_UNSAFE', 'TUF target 下载路径越界')
  }
  const handle = await open(absolutePath, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const metadata = await handle.stat()
    if (!metadata.isFile() || metadata.uid !== currentUid() || metadata.nlink !== 1
      || metadata.size !== expectedLength || metadata.size <= 0 || metadata.size > 512 * 1024 * 1024) {
      throw updateError('E2E_RUNTIME_UPDATE_TARGET_FILE_UNSAFE', 'TUF target 不是当前用户独占且长度匹配的普通文件')
    }
    const canonicalDirectory = await realpath(targetDirectory)
    const canonicalPath = await realpath(absolutePath)
    const canonicalRelative = relative(canonicalDirectory, canonicalPath)
    if (canonicalRelative === '' || canonicalRelative === '..' || canonicalRelative.startsWith(`..${sep}`)
      || isAbsolute(canonicalRelative)) {
      throw updateError('E2E_RUNTIME_UPDATE_TARGET_FILE_UNSAFE', 'TUF target 真实路径越界')
    }
    await handle.chmod(0o600)
  } finally { await handle.close() }
}

async function realDirectory(path: string): Promise<string> {
  const metadata = await lstat(path)
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || metadata.uid !== currentUid()) {
    throw updateError('E2E_RUNTIME_UPDATE_DIRECTORY_UNSAFE', 'TUF target 目录不安全')
  }
  return await realpath(path)
}

function updateRoots(homeDir: string) {
  const root = join(runtimeLayout(homeDir).state, 'runtime-update')
  return { root, metadata: join(root, 'metadata'), targets: join(root, 'targets') }
}

function validateClientConfig(options: TufRuntimeUpdateClientOptions) {
  if (!isAbsolute(options.trustedRootPath)
    || !/^[A-Za-z0-9@._/+~-]+$/.test(options.targetPath)
    || options.targetPath.startsWith('/') || options.targetPath.includes('..')) {
    throw updateError('E2E_RUNTIME_UPDATE_CLIENT_CONFIG_INVALID', 'trusted root 或 target path 配置无效')
  }
  const metadataBaseUrl = secureBaseUrl(options.metadataBaseUrl)
  const targetBaseUrl = secureBaseUrl(options.targetBaseUrl)
  return { metadataBaseUrl, targetBaseUrl, targetPath: options.targetPath }
}

function secureBaseUrl(candidate: string): string {
  let url: URL
  try { url = new URL(candidate) } catch (cause) {
    throw updateError('E2E_RUNTIME_UPDATE_CLIENT_CONFIG_INVALID', '更新 base URL 无效', cause)
  }
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '' || url.hash !== '') {
    throw updateError('E2E_RUNTIME_UPDATE_CLIENT_CONFIG_INVALID', '更新 base URL 必须是无凭证 HTTPS URL')
  }
  return url.href
}

function secureOrigin(candidate: string): string {
  let url: URL
  try { url = new URL(candidate) } catch (cause) {
    throw updateError('E2E_RUNTIME_UPDATE_CLIENT_CONFIG_INVALID', '更新 origin 无效', cause)
  }
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '' || url.hash !== '') {
    throw updateError('E2E_RUNTIME_UPDATE_CLIENT_CONFIG_INVALID', '更新 origin 必须是无凭证 HTTPS origin')
  }
  return url.origin
}

function metadataLimit(role: 'root' | 'timestamp' | 'snapshot' | 'targets'): number {
  return { root: 512_000, timestamp: 16_384, snapshot: 2_000_000, targets: 5_000_000 }[role]
}

function updateError(code: string, message: string, cause?: unknown): RuntimeUpdateError {
  return new RuntimeUpdateError(code, message, cause === undefined ? undefined : { cause })
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && (error as NodeJS.ErrnoException).code === code
}
