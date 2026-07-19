import { digestBytes, E2EError } from '@mutil-skills/e2e-contracts'
import { spawn } from 'node:child_process'
import { constants } from 'node:fs'
import { lstat, open, realpath } from 'node:fs/promises'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { currentUid } from './runtime-manifest.js'
import {
  BrowserSelectionSchema,
  type BrowserSelection,
  type BrowserSource,
} from './runtime-user-config.js'

export const SYSTEM_CHROME_PATHS: Readonly<Record<'darwin' | 'linux', readonly string[]>> = Object.freeze({
  darwin: Object.freeze(['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']),
  linux: Object.freeze([
    '/usr/bin/google-chrome-stable',
    '/usr/bin/google-chrome',
    '/opt/google/chrome/google-chrome',
  ]),
})

export interface SystemChromeIdentity {
  device: number
  inode: number
  uid: number
  byteLength: number
}

export type SystemChromeSelection = Omit<BrowserSelection, 'source'> & {
  source: Extract<BrowserSource, { kind: 'system-chrome' }>
}

export interface InspectedSystemChrome {
  selection: SystemChromeSelection
  identity: SystemChromeIdentity
}

export async function discoverSystemChrome(options: {
  platform?: NodeJS.Platform
  exists?: (path: string) => Promise<boolean>
} = {}): Promise<string> {
  const platform = options.platform ?? process.platform
  if (platform !== 'darwin' && platform !== 'linux') throw chromeError(
    'E2E_SYSTEM_CHROME_PLATFORM_UNSUPPORTED', '系统 Google Chrome 首期只支持 macOS 与 Linux')
  const exists = options.exists ?? executableExists
  for (const candidate of SYSTEM_CHROME_PATHS[platform]) {
    if (await exists(candidate)) return candidate
  }
  throw chromeError('E2E_SYSTEM_CHROME_NOT_FOUND', '固定平台路径中未找到 Google Chrome stable')
}

export async function inspectSystemChrome(input: {
  executablePath: string
  projectRoot: string
  runtimeInstallationDigest: string
  controlledLaunchProofDigest: string
  configuredAt: string
  readVersion?: (executablePath: string) => Promise<string>
}): Promise<InspectedSystemChrome> {
  if (!isAbsolute(input.executablePath) || !isAbsolute(input.projectRoot)) throw chromeError(
    'E2E_SYSTEM_CHROME_PATH_INVALID', '系统 Chrome 与项目根路径必须是绝对路径')
  const requested = resolve(input.executablePath)
  const unresolvedProjectRoot = resolve(input.projectRoot)
  const projectRoot = await realpath(input.projectRoot)
  if (isWithin(unresolvedProjectRoot, requested) || isWithin(projectRoot, requested)) throw chromeError(
    'E2E_SYSTEM_CHROME_PROJECT_PATH_FORBIDDEN', '系统 Chrome 候选不得来自项目目录')
  const canonicalPath = await realpath(requested).catch((cause) => {
    throw chromeError('E2E_SYSTEM_CHROME_NOT_FOUND', '系统 Chrome 候选不存在', cause)
  })
  if (isWithin(projectRoot, canonicalPath)) throw chromeError(
    'E2E_SYSTEM_CHROME_PROJECT_PATH_FORBIDDEN', '系统 Chrome canonical path 不得位于项目目录')
  const opened = await open(canonicalPath, constants.O_RDONLY | constants.O_NOFOLLOW).catch((cause) => {
    throw chromeError('E2E_SYSTEM_CHROME_EXECUTABLE_UNSAFE', '系统 Chrome 候选无法安全打开', cause)
  })
  try {
    const before = await opened.stat()
    if (!before.isFile() || before.nlink < 1 || (before.mode & 0o111) === 0
      || (before.mode & 0o022) !== 0 || ![0, currentUid()].includes(before.uid)
      || before.size <= 0 || before.size > 2 * 1024 * 1024 * 1024) {
      throw chromeError('E2E_SYSTEM_CHROME_EXECUTABLE_UNSAFE',
        '系统 Chrome 必须是 root/当前用户所有、不可由组或其他用户写入的可执行普通文件')
    }
    const bytes = await opened.readFile()
    const after = await opened.stat()
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
      || before.mtimeMs !== after.mtimeMs) throw chromeError(
      'E2E_SYSTEM_CHROME_PATH_REPLACED', '读取期间系统 Chrome 可执行文件发生变化')
    const browserVersion = (await (input.readVersion ?? readSystemChromeVersion)(canonicalPath)).trim()
    if (!/^Google Chrome \d+(?:\.\d+){0,3}(?:\s.*)?$/.test(browserVersion)) throw chromeError(
      'E2E_SYSTEM_CHROME_VERSION_INVALID', '候选未返回受支持的 Google Chrome stable 版本')
    return {
      selection: BrowserSelectionSchema.parse({
        schemaVersion: '1.0.0',
        source: { kind: 'system-chrome', executablePath: canonicalPath },
        browserVersion,
        executableDigest: digestBytes('e2e-browser-executable/v1', bytes),
        runtimeInstallationDigest: input.runtimeInstallationDigest,
        controlledLaunchProofDigest: input.controlledLaunchProofDigest,
        configuredAt: input.configuredAt,
      }) as SystemChromeSelection,
      identity: {
        device: Number(before.dev), inode: Number(before.ino), uid: before.uid, byteLength: before.size,
      },
    }
  } finally { await opened.close() }
}

export async function revalidateSystemChrome(
  expected: InspectedSystemChrome | InspectedSystemChrome['selection'],
  options: { projectRoot: string; readVersion?: (executablePath: string) => Promise<string> },
): Promise<InspectedSystemChrome> {
  const selection = 'selection' in expected ? expected.selection : expected
  const inspected = await inspectSystemChrome({
    executablePath: selection.source.executablePath,
    projectRoot: options.projectRoot,
    runtimeInstallationDigest: selection.runtimeInstallationDigest,
    controlledLaunchProofDigest: selection.controlledLaunchProofDigest,
    configuredAt: selection.configuredAt,
    ...(options.readVersion === undefined ? {} : { readVersion: options.readVersion }),
  }).catch((cause) => {
    if (cause instanceof E2EError && cause.code === 'E2E_SYSTEM_CHROME_REVALIDATION_REQUIRED') throw cause
    throw chromeError('E2E_SYSTEM_CHROME_REVALIDATION_REQUIRED',
      '系统 Chrome 无法重新验证；请重新运行 configure-browser --system', cause)
  })
  const expectedIdentity = 'identity' in expected ? expected.identity : undefined
  if (inspected.selection.source.executablePath !== selection.source.executablePath
    || inspected.selection.browserVersion !== selection.browserVersion
    || inspected.selection.executableDigest !== selection.executableDigest
    || (expectedIdentity !== undefined
      && (inspected.identity.device !== expectedIdentity.device || inspected.identity.inode !== expectedIdentity.inode))) {
    throw chromeError('E2E_SYSTEM_CHROME_REVALIDATION_REQUIRED',
      '系统 Chrome 路径、版本或 executable digest 已改变；请重新配置')
  }
  return inspected
}

async function executableExists(path: string): Promise<boolean> {
  try {
    const metadata = await lstat(path)
    return metadata.isFile() && (metadata.mode & 0o111) !== 0
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) return false
    throw error
  }
}

async function readSystemChromeVersion(executablePath: string): Promise<string> {
  return await new Promise<string>((resolvePromise, reject) => {
    const child = spawn(executablePath, ['--version'], {
      cwd: dirname(executablePath), stdio: ['ignore', 'pipe', 'pipe'],
      env: { HOME: '/nonexistent', LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8', PATH: '/usr/bin:/bin' },
    })
    const chunks: Buffer[] = []
    let length = 0
    const timer = setTimeout(() => { child.kill('SIGKILL') }, 5_000)
    child.stdout.on('data', (chunk: Buffer) => {
      length += chunk.byteLength
      if (length <= 16 * 1024) chunks.push(chunk)
    })
    child.once('error', reject)
    child.once('close', (code) => {
      clearTimeout(timer)
      if (code !== 0 || length > 16 * 1024) reject(chromeError(
        'E2E_SYSTEM_CHROME_VERSION_INVALID', '无法读取受限长度的系统 Chrome 版本'))
      else resolvePromise(Buffer.concat(chunks).toString('utf8'))
    })
  })
}

function isWithin(root: string, candidate: string): boolean {
  const path = relative(root, candidate)
  return path === '' || (!path.startsWith(`..${sep}`) && path !== '..' && !isAbsolute(path))
}

function chromeError(code: string, message: string, cause?: unknown): E2EError {
  return new E2EError({ code, category: 'environment', message, retryable: false, cause })
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && (error as NodeJS.ErrnoException).code === code
}
