import { canonicalizeJson, digestBytes, digestText, E2EError } from '@mutil-skills/e2e-contracts'
import {
  lstat,
  mkdir,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { dirname, isAbsolute, join, resolve } from 'node:path'

const SAFE_ID = /^[A-Za-z0-9._:-]{1,256}$/
const DIGEST = /^sha256:[a-f0-9]{64}$/

export interface StandaloneEvidenceFile {
  caseId: string
  checkpointId: string
  kind: 'screenshot' | 'trace' | 'dom'
  relativePath: string
  bytes: Uint8Array
}

export interface StandaloneEvidencePublishInput {
  assetId: string
  runId: string
  generationDigest: string
  outputRoot?: string
  rendered: { json: string; markdown: string; html: string }
  evidence: StandaloneEvidenceFile[]
}

export class StandaloneEvidencePublisher {
  readonly #homeDir: string

  constructor(options: { homeDir: string }) {
    this.#homeDir = resolve(options.homeDir)
  }

  async publish(input: StandaloneEvidencePublishInput): Promise<string> {
    validateInput(input)
    const finalRoot = input.outputRoot === undefined
      ? join(this.#homeDir, '.mutil-skills', 'e2e', 'reports', input.assetId, input.runId)
      : resolve(input.outputRoot)
    await assertExistingOutputSafe(finalRoot)
    const parent = dirname(finalRoot)
    await mkdir(parent, { recursive: true, mode: 0o700 })
    if (normalizePlatformAlias(await realpath(parent)) !== normalizePlatformAlias(resolve(parent))) {
      throw publisherError('E2E_EVIDENCE_OUTPUT_ROOT_UNSAFE', 'outputRoot 父目录包含符号链接')
    }

    const files = buildFiles(input)
    const records = Object.fromEntries(files.map((file) => [file.relativePath, {
      kind: file.kind,
      digest: digestBytes(`standalone-evidence/${file.kind}/v1`, file.bytes),
      byteLength: file.bytes.byteLength,
      ...(file.caseId === undefined ? {} : { caseId: file.caseId }),
      ...(file.checkpointId === undefined ? {} : { checkpointId: file.checkpointId }),
    }]))
    const manifestDraft = {
      schemaVersion: '1.0.0',
      assetId: input.assetId,
      runId: input.runId,
      generationDigest: input.generationDigest,
      files: records,
    }
    const manifest = {
      ...manifestDraft,
      manifestDigest: digestText('standalone-evidence-manifest/v1', canonicalizeJson(manifestDraft)),
    }
    const manifestText = `${JSON.stringify(manifest, null, 2)}\n`
    const existing = await readFile(join(finalRoot, 'manifest.json'), 'utf8').catch(() => undefined)
    if (existing !== undefined) {
      if (existing !== manifestText) throw publisherError(
        'E2E_EVIDENCE_OUTPUT_CONFLICT', '同一 outputRoot 已存在不同验收证据',
      )
      return finalRoot
    }

    const temporaryRoot = join(parent, `.${input.runId}.tmp-${randomUUID()}`)
    await mkdir(temporaryRoot, { mode: 0o700 })
    try {
      for (const file of files) {
        const target = join(temporaryRoot, file.relativePath)
        await mkdir(dirname(target), { recursive: true, mode: 0o700 })
        await writeFile(target, file.bytes, { mode: 0o600, flag: 'wx' })
      }
      await writeFile(join(temporaryRoot, 'manifest.json'), manifestText, {
        encoding: 'utf8', mode: 0o600, flag: 'wx',
      })
      await rename(temporaryRoot, finalRoot)
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException)?.code === 'EEXIST') throw publisherError(
        'E2E_EVIDENCE_OUTPUT_CONFLICT', 'outputRoot 已被并发创建', cause,
      )
      throw cause
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true })
    }
    return finalRoot
  }
}

interface OutputFile {
  kind: 'screenshot' | 'trace' | 'dom' | 'report-json' | 'report-markdown' | 'report-html'
  relativePath: string
  bytes: Uint8Array
  caseId?: string
  checkpointId?: string
}

function buildFiles(input: StandaloneEvidencePublishInput): OutputFile[] {
  const reportFiles: OutputFile[] = [
    { kind: 'report-json', relativePath: 'final-report.json', bytes: Buffer.from(input.rendered.json) },
    { kind: 'report-markdown', relativePath: 'final-report.md', bytes: Buffer.from(input.rendered.markdown) },
    { kind: 'report-html', relativePath: 'final-report.html', bytes: Buffer.from(input.rendered.html) },
  ]
  return [
    ...input.evidence.map((file): OutputFile => ({
      kind: file.kind, relativePath: file.relativePath, bytes: Buffer.from(file.bytes),
      caseId: file.caseId, checkpointId: file.checkpointId,
    })),
    ...reportFiles,
  ]
}

function validateInput(input: StandaloneEvidencePublishInput): void {
  if (!SAFE_ID.test(input.assetId) || !SAFE_ID.test(input.runId) || !DIGEST.test(input.generationDigest)
    || input.evidence.length > 100_000) {
    throw publisherError('E2E_EVIDENCE_OUTPUT_INPUT_INVALID', '证据发布输入无效')
  }
  const paths = new Set<string>()
  for (const file of input.evidence) {
    if (!SAFE_ID.test(file.caseId) || !SAFE_ID.test(file.checkpointId)
      || !safeRelativePath(file.relativePath)
      || !file.relativePath.startsWith(`evidence/${file.caseId}/`)
      || paths.has(file.relativePath)) {
      throw publisherError('E2E_EVIDENCE_OUTPUT_PATH_INVALID', '证据路径必须唯一且位于对应 Case 目录')
    }
    paths.add(file.relativePath)
    if (!validMedia(file)) {
      throw publisherError('E2E_EVIDENCE_MEDIA_INVALID', '截图、Trace 或 DOM 媒体格式无效')
    }
  }
}

function safeRelativePath(path: string): boolean {
  return path.length > 0 && path.length <= 4096 && !isAbsolute(path)
    && !path.includes('\\') && !path.includes(':')
    && path.split('/').every((part) => part !== '' && part !== '.' && part !== '..')
}

function validMedia(file: StandaloneEvidenceFile): boolean {
  const bytes = Buffer.from(file.bytes)
  if (file.kind === 'screenshot') {
    return file.relativePath.endsWith('.png') && bytes.length >= 8
      && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  }
  if (file.kind === 'trace') {
    return file.relativePath.endsWith('.zip') && bytes.length >= 4
      && bytes.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]))
  }
  return file.relativePath.endsWith('.html') && bytes.length > 0
}

async function assertExistingOutputSafe(path: string): Promise<void> {
  const info = await lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return undefined
    throw error
  })
  if (info === undefined) return
  if (!info.isDirectory() || info.isSymbolicLink()
    || normalizePlatformAlias(await realpath(path)) !== normalizePlatformAlias(resolve(path))) {
    throw publisherError('E2E_EVIDENCE_OUTPUT_ROOT_UNSAFE', 'outputRoot 必须是正规目录且不得是符号链接')
  }
}

function normalizePlatformAlias(path: string): string {
  if (process.platform !== 'darwin') return path
  for (const alias of ['/etc', '/tmp', '/var']) {
    if (path === alias || path.startsWith(`${alias}/`)) return `/private${path}`
  }
  return path
}

function publisherError(code: string, message: string, cause?: unknown): E2EError {
  return new E2EError({ code, category: 'artifact', message, retryable: false, cause })
}
