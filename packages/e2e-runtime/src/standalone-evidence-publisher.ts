import { canonicalizeJson, digestBytes, digestText, E2EError } from '@mutil-skills/e2e-contracts'
import {
  lstat,
  mkdir,
  readFile,
  readdir,
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
  rendered: {
    json: string
    markdown: string
    html: string
    explanation?: { json: string; markdown: string; html: string }
  }
  evidence: StandaloneEvidenceFile[]
}

export interface StandaloneRuntimeEvidencePublishInput extends Omit<
  StandaloneEvidencePublishInput,
  'evidence'
> {
  cases: Array<{
    caseId: string
    actionId: string
    attemptId: string
  }>
}

export class StandaloneEvidencePublisher {
  readonly #homeDir: string

  constructor(options: { homeDir: string }) {
    this.#homeDir = resolve(options.homeDir)
  }

  async publishRuntimeState(input: StandaloneRuntimeEvidencePublishInput): Promise<string> {
    if (input.cases.length === 0 || input.cases.length > 1_000
      || input.cases.some((item) => !SAFE_ID.test(item.caseId)
        || !SAFE_ID.test(item.actionId) || !SAFE_ID.test(item.attemptId))
      || new Set(input.cases.map((item) => item.caseId)).size !== input.cases.length) {
      throw publisherError('E2E_EVIDENCE_RUNTIME_BINDING_INVALID', 'Runtime Case/Action/Attempt 绑定无效')
    }
    const stateRoot = join(this.#homeDir, '.mutil-skills', 'e2e', 'state')
    const evidence: StandaloneEvidenceFile[] = []
    for (const item of input.cases) {
      const recoveryDirectory = digestText(
        'runtime-full-playwright-recovery-directory/v1',
        item.attemptId,
      ).slice(7, 39)
      const recoveryRoot = join(stateRoot, 'full-playwright-recovery', recoveryDirectory)
      evidence.push({
        caseId: item.caseId,
        checkpointId: item.actionId,
        kind: 'screenshot',
        relativePath: `evidence/${item.caseId}/${item.actionId}.png`,
        bytes: await readRuntimeEvidenceFile(
          stateRoot,
          join(recoveryRoot, 'screenshot.bin'),
          16 * 1024 * 1024,
        ),
      })
      const traceRoot = join(stateRoot, 'full-playwright-traces', item.attemptId)
      const traceNames = (await readdir(traceRoot)).filter((name) =>
        /^[A-Za-z0-9._-]+\.zip$/.test(name)).sort()
      if (traceNames.length === 0 || traceNames.length > 10_000) throw publisherError(
        'E2E_EVIDENCE_RUNTIME_TRACE_MISSING',
        '生产 Playwright 执行没有可发布的 Trace',
      )
      for (const [index, name] of traceNames.entries()) {
        const checkpointId = `TRACE-${String(index + 1).padStart(3, '0')}`
        evidence.push({
          caseId: item.caseId,
          checkpointId,
          kind: 'trace',
          relativePath: `evidence/${item.caseId}/trace-${String(index + 1).padStart(3, '0')}-${name}`,
          bytes: await readRuntimeEvidenceFile(
            stateRoot,
            join(traceRoot, name),
            256 * 1024 * 1024,
          ),
        })
      }
    }
    return await this.publish({ ...input, evidence })
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
      await verifyExistingPublication(finalRoot, files, manifestText)
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

async function readRuntimeEvidenceFile(
  stateRoot: string,
  path: string,
  maxBytes: number,
): Promise<Buffer> {
  const normalizedStateRoot = resolve(stateRoot)
  const normalizedPath = resolve(path)
  if (!normalizedPath.startsWith(`${normalizedStateRoot}/`)) throw publisherError(
    'E2E_EVIDENCE_RUNTIME_PATH_INVALID',
    'Runtime evidence 路径越出状态根',
  )
  const info = await lstat(normalizedPath)
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1
    || info.size <= 0 || info.size > maxBytes
    || normalizePlatformAlias(await realpath(normalizedPath)) !== normalizePlatformAlias(normalizedPath)) {
    throw publisherError('E2E_EVIDENCE_RUNTIME_FILE_UNSAFE', 'Runtime evidence 不是安全的唯一正规文件')
  }
  return await readFile(normalizedPath)
}

interface OutputFile {
  kind: 'screenshot' | 'trace' | 'dom' | 'report-json' | 'report-markdown' | 'report-html'
    | 'explanation-json' | 'explanation-markdown' | 'explanation-html'
  relativePath: string
  bytes: Uint8Array
  caseId?: string
  checkpointId?: string
}

function buildFiles(input: StandaloneEvidencePublishInput): OutputFile[] {
  const evidenceSection = renderEvidenceSection(input.evidence)
  const standaloneRendered = removeUnpublishedDomLinks(input.rendered)
  const reportFiles: OutputFile[] = [
    { kind: 'report-json', relativePath: 'final-report.json', bytes: Buffer.from(input.rendered.json) },
    {
      kind: 'report-markdown',
      relativePath: 'final-report.md',
      bytes: Buffer.from(`${standaloneRendered.markdown}${evidenceSection.markdown}`),
    },
    {
      kind: 'report-html',
      relativePath: 'final-report.html',
      bytes: Buffer.from(insertHtmlEvidence(standaloneRendered.html, evidenceSection.html)),
    },
  ]
  if (input.rendered.explanation !== undefined) {
    reportFiles.push(
      {
        kind: 'explanation-json', relativePath: 'execution-explanation.json',
        bytes: Buffer.from(input.rendered.explanation.json),
      },
      {
        kind: 'explanation-markdown', relativePath: 'execution-explanation.md',
        bytes: Buffer.from(input.rendered.explanation.markdown),
      },
      {
        kind: 'explanation-html', relativePath: 'execution-explanation.html',
        bytes: Buffer.from(input.rendered.explanation.html),
      },
    )
  }
  return [
    ...input.evidence.map((file): OutputFile => ({
      kind: file.kind, relativePath: file.relativePath, bytes: Buffer.from(file.bytes),
      caseId: file.caseId, checkpointId: file.checkpointId,
    })),
    ...reportFiles,
  ]
}

function removeUnpublishedDomLinks(rendered: StandaloneEvidencePublishInput['rendered']): {
  markdown: string
  html: string
} {
  const notice = '（原始 DOM 未在独立报告中发布）'
  return {
    markdown: rendered.markdown.replace(
      /\[([^\]\n]+)\]\(<evidence\/[A-Za-z0-9._/-]+\.dom\.json>\)/g,
      `$1${notice}`,
    ),
    html: rendered.html.replace(
      /<a href="evidence\/[A-Za-z0-9._/-]+\.dom\.json">([^<]+)<\/a>/g,
      `<span data-evidence-kind="dom">$1${notice}</span>`,
    ),
  }
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
    && /^[A-Za-z0-9._/-]+$/.test(path)
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
  if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077) !== 0
    || (typeof process.getuid === 'function' && info.uid !== process.getuid())
    || normalizePlatformAlias(await realpath(path)) !== normalizePlatformAlias(resolve(path))) {
    throw publisherError('E2E_EVIDENCE_OUTPUT_ROOT_UNSAFE', 'outputRoot 必须是正规目录且不得是符号链接')
  }
}

async function verifyExistingPublication(
  root: string,
  files: OutputFile[],
  manifestText: string,
): Promise<void> {
  const expected = [
    ...files.map((file) => ({
      relativePath: file.relativePath,
      bytes: Buffer.from(file.bytes),
    })),
    { relativePath: 'manifest.json', bytes: Buffer.from(manifestText) },
  ]
  try {
    for (const file of expected) {
      const path = join(root, file.relativePath)
      const info = await lstat(path)
      if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1
        || (info.mode & 0o077) !== 0
        || (typeof process.getuid === 'function' && info.uid !== process.getuid())
        || normalizePlatformAlias(await realpath(path)) !== normalizePlatformAlias(resolve(path))) {
        throw new Error('unsafe existing evidence file')
      }
      const bytes = await readFile(path)
      if (!bytes.equals(file.bytes)) throw new Error('existing evidence bytes changed')
    }
  } catch (cause) {
    throw publisherError(
      'E2E_EVIDENCE_OUTPUT_INTEGRITY_INVALID',
      '已存在的独立验收证据未通过逐文件完整性复验',
      cause,
    )
  }
}

function renderEvidenceSection(evidence: StandaloneEvidenceFile[]): {
  markdown: string
  html: string
} {
  if (evidence.length === 0) return { markdown: '', html: '' }
  const markdownItems = evidence.map((file) => file.kind === 'screenshot'
    ? `- ${file.caseId} / ${file.checkpointId}: ![${file.caseId} / ${file.checkpointId}](${file.relativePath})`
    : file.kind === 'trace'
      ? `- ${file.caseId} / ${file.checkpointId}: [下载 Trace](${file.relativePath})`
      : `- ${file.caseId} / ${file.checkpointId}: [查看 DOM](${file.relativePath})`)
  const htmlItems = evidence.map((file) => file.kind === 'screenshot'
    ? `<figure><img src="${file.relativePath}" alt="${file.caseId} / ${file.checkpointId}" loading="lazy"><figcaption>${file.caseId} / ${file.checkpointId}</figcaption></figure>`
    : file.kind === 'trace'
      ? `<p><a href="${file.relativePath}" download>${file.caseId} / ${file.checkpointId}：下载 Playwright Trace</a></p>`
      : `<p><a href="${file.relativePath}">${file.caseId} / ${file.checkpointId}：查看 DOM</a></p>`)
  return {
    markdown: `\n\n## 浏览器验收证据\n\n${markdownItems.join('\n')}\n`,
    html: `<section id="browser-acceptance-evidence"><h2>浏览器验收证据</h2>${htmlItems.join('')}</section>`,
  }
}

function insertHtmlEvidence(html: string, section: string): string {
  if (section === '') return html
  for (const closing of ['</main>', '</body>', '</html>']) {
    const index = html.lastIndexOf(closing)
    if (index >= 0) return `${html.slice(0, index)}${section}${html.slice(index)}`
  }
  return `${html}${section}`
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
