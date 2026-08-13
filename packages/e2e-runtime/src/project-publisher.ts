import { lstat, mkdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { ArtifactSchemaRegistry, E2EError, digestBytes } from '@mutil-skills/e2e-contracts'
import {
  LocalArtifactStore,
  createCompletePublicationAuditor,
  type ActiveGeneration,
  type ArtifactStoreAuthority,
  type CompleteGenerationBuild,
  type PrivacyScanner,
} from '@mutil-skills/e2e-engine'
import { renderCompleteReport, type RenderedCompleteReport } from '@mutil-skills/e2e-report'

export class ProjectPublisher {
  readonly projectRoot: string
  readonly storeRoot: string
  readonly artifactRoot: string

  constructor(input: {
    projectRoot: string
    scanner: PrivacyScanner
    authority: Omit<ArtifactStoreAuthority, 'auditStagedGeneration'>
  }) {
    if (!isAbsolute(input.projectRoot)) throw publisherError(
      'E2E_PROJECT_PUBLISHER_ROOT_INVALID', 'ProjectPublisher 需要绝对项目路径',
    )
    this.projectRoot = normalizePlatformAlias(resolve(input.projectRoot))
    // LocalArtifactStore 会在 root 下自行追加 `.biztest`；这里必须传项目根，
    // 否则会误发布到 `.biztest/.biztest` 并使报告入口与文档路径分裂。
    this.storeRoot = this.projectRoot
    this.artifactRoot = join(this.projectRoot, '.biztest')
    this.scanner = input.scanner
    this.authority = input.authority
  }

  private readonly scanner: PrivacyScanner
  private readonly authority: Omit<ArtifactStoreAuthority, 'auditStagedGeneration'>

  async publish(input: {
    assetId: string
    generationId: string
    prepare(input: { fencingToken: number }): CompleteGenerationBuild | Promise<CompleteGenerationBuild>
  }): Promise<ActiveGeneration> {
    await this.assertProjectBoundary()
    let prepared: CompleteGenerationBuild | undefined
    const auditor = createCompletePublicationAuditor({
      scanner: this.scanner,
      resolveValidationInput: () => {
        if (prepared === undefined) throw publisherError(
          'E2E_PROJECT_PUBLICATION_PREPARATION_MISSING', 'staged audit 之前 generation 尚未准备完成',
        )
        return prepared.validationInput
      },
    })
    const store = new LocalArtifactStore(this.storeRoot, {
      ...this.authority,
      auditStagedGeneration: auditor,
    })
    const active = await store.publishPrepared({
      assetId: input.assetId,
      generationId: input.generationId,
      prepare: async ({ fencingToken }) => {
        prepared = await input.prepare({ fencingToken })
        return {
          terminalVerdict: prepared.terminalVerdict,
          files: Object.fromEntries(prepared.files.map((file) => [file.path, file.bytes])),
        }
      },
    })
    const committed = await store.readActive(input.assetId)
    if (committed === undefined || committed.generationId !== active.generationId
      || committed.generationDigest !== active.generationDigest) {
      throw publisherError(
        'E2E_PROJECT_PUBLICATION_ACTIVE_MISMATCH', 'commit 后 active generation 摘要复读不一致',
      )
    }
    return committed
  }

  async renderActiveReport(input: {
    assetId: string
    expectedGenerationId: string
    expectedProjectIdentityDigest: string
  }): Promise<{
    active: Pick<ActiveGeneration, 'generationId' | 'generationDigest' | 'terminalVerdict'>
    rendered: RenderedCompleteReport
    reportDirectory: string
  }> {
    await this.assertProjectBoundary()
    const store = new LocalArtifactStore(this.storeRoot, {
      ...this.authority,
      auditStagedGeneration: async () => {
        throw publisherError('E2E_PROJECT_REPORT_STAGING_DENIED', '报告命令不得读取 staging')
      },
    })
    const active = await store.readActive(input.assetId)
    if (active === undefined) throw publisherError('E2E_PROJECT_ACTIVE_GENERATION_MISSING', '没有 active generation')
    if (active.generationId !== input.expectedGenerationId) throw publisherError(
      'E2E_PROJECT_ACTIVE_GENERATION_MISMATCH', 'active generation 与请求的 Run 不一致',
    )
    const reportPath = join(active.generationPath, 'run', 'final-report.json')
    let report: unknown
    try { report = JSON.parse(await readFile(reportPath, 'utf8')) } catch (cause) {
      throw publisherError('E2E_PROJECT_ACTIVE_REPORT_INVALID', 'active final-report 无效', cause)
    }
    const parsed = ArtifactSchemaRegistry['final-report'].safeParse(report)
    if (!parsed.success || parsed.data.assetId !== input.assetId
      || parsed.data.generationId !== input.expectedGenerationId
      || parsed.data.content.runtimeProvenance.projectIdentityDigest
        !== input.expectedProjectIdentityDigest) throw publisherError(
      'E2E_PROJECT_ACTIVE_REPORT_BINDING_MISMATCH', 'active final-report 与项目、资产或 Run 绑定不一致',
      parsed.success ? undefined : parsed.error,
    )
    const rendered = renderCompleteReport(parsed.data)
    const reportDirectory = await this.persistRenderedReport({
      assetId: input.assetId, generationId: active.generationId,
      generationDigest: active.generationDigest, rendered,
    })
    return {
      active: {
        generationId: active.generationId,
        generationDigest: active.generationDigest,
        terminalVerdict: active.terminalVerdict,
      },
      rendered,
      reportDirectory,
    }
  }

  private async persistRenderedReport(input: {
    assetId: string
    generationId: string
    generationDigest: string
    rendered: RenderedCompleteReport
  }): Promise<string> {
    if (!/^[A-Za-z0-9._:-]{1,256}$/.test(input.assetId)
      || !/^[A-Za-z0-9._:-]{1,256}$/.test(input.generationId)) {
      throw publisherError('E2E_PROJECT_REPORT_PATH_INVALID', '报告 asset/generation ID 不能安全落盘')
    }
    const reportsRoot = join(this.artifactRoot, 'reports')
    await mkdir(reportsRoot, { recursive: true, mode: 0o700 })
    if (await realpath(reportsRoot) !== reportsRoot) {
      throw publisherError('E2E_PROJECT_REPORT_PATH_INVALID', '报告目录不得通过符号链接逃逸项目边界')
    }
    const assetRoot = join(reportsRoot, input.assetId)
    await mkdir(assetRoot, { recursive: true, mode: 0o700 })
    if (await realpath(assetRoot) !== assetRoot) {
      throw publisherError('E2E_PROJECT_REPORT_PATH_INVALID', '报告资产目录不得通过符号链接逃逸项目边界')
    }
    const finalRoot = join(assetRoot, input.generationId)
    const temporaryRoot = join(assetRoot, `.${input.generationId}.tmp-${randomUUID()}`)
    const files = {
      json: { path: 'final-report.json', text: input.rendered.json },
      markdown: { path: 'final-report.md', text: input.rendered.markdown },
      html: { path: 'final-report.html', text: input.rendered.html },
      explanationJson: { path: 'execution-explanation.json', text: input.rendered.explanation.json },
      explanationMarkdown: { path: 'execution-explanation.md', text: input.rendered.explanation.markdown },
      explanationHtml: { path: 'execution-explanation.html', text: input.rendered.explanation.html },
    } as const
    const manifest = {
      schemaVersion: '1.0.0', assetId: input.assetId, generationId: input.generationId,
      generationDigest: input.generationDigest,
      files: Object.fromEntries(Object.entries(files).map(([kind, file]) => [kind, {
        path: file.path,
        digest: digestBytes(`rendered-report/${kind}/v1`, Buffer.from(file.text, 'utf8')),
        byteLength: Buffer.byteLength(file.text, 'utf8'),
      }])),
    }
    await mkdir(temporaryRoot, { mode: 0o700 })
    try {
      await Promise.all(Object.values(files).map((file) =>
        writeFile(join(temporaryRoot, file.path), file.text, { encoding: 'utf8', mode: 0o600, flag: 'wx' })))
      await writeFile(join(temporaryRoot, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`,
        { encoding: 'utf8', mode: 0o600, flag: 'wx' })
      try {
        await rename(temporaryRoot, finalRoot)
      } catch (error) {
        if (!isAlreadyExists(error)) throw error
        const existing = await readFile(join(finalRoot, 'manifest.json'), 'utf8').catch(() => '')
        if (existing !== `${JSON.stringify(manifest, null, 2)}\n`) {
          throw publisherError('E2E_PROJECT_REPORT_OUTPUT_CONFLICT', '同一 generation 已存在不同摘要的报告视图')
        }
      }
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true })
    }
    return finalRoot
  }

  async readActiveGeneration(
    assetId: string,
    expectedGenerationId: string,
  ): Promise<Pick<ActiveGeneration, 'generationId' | 'generationDigest' | 'terminalVerdict'> | undefined> {
    await this.assertProjectBoundary()
    const store = new LocalArtifactStore(this.storeRoot, {
      ...this.authority,
      auditStagedGeneration: async () => {
        throw publisherError('E2E_PROJECT_REPORT_STAGING_DENIED', 'active 复读不得读取 staging')
      },
    })
    const active = await store.readActive(assetId)
    if (active === undefined) return undefined
    if (active.generationId !== expectedGenerationId) throw publisherError(
      'E2E_PROJECT_ACTIVE_GENERATION_MISMATCH', 'active generation 与请求的 Run 不一致',
    )
    return {
      generationId: active.generationId,
      generationDigest: active.generationDigest,
      terminalVerdict: active.terminalVerdict,
    }
  }

  private async assertProjectBoundary(): Promise<void> {
    let canonical: string
    try { canonical = await realpath(this.projectRoot) } catch (cause) {
      throw publisherError('E2E_PROJECT_PUBLISHER_ROOT_INVALID', '项目根不存在', cause)
    }
    if (canonical !== this.projectRoot) {
      throw publisherError('E2E_PROJECT_PUBLISHER_ROOT_INVALID', '项目根路径不是规范 realpath')
    }
    try {
      await lstat(join(this.artifactRoot, 'quarantine'))
      throw publisherError(
        'E2E_PROJECT_QUARANTINE_MATERIAL_DETECTED', '项目 .biztest 内不得存在任何 quarantine material',
      )
    } catch (error) {
      if (error instanceof E2EError) throw error
      if (!isMissing(error)) throw error
    }
  }
}

function normalizePlatformAlias(path: string): string {
  if (process.platform !== 'darwin') return path
  for (const alias of ['/etc', '/tmp', '/var']) {
    if (path === alias || path.startsWith(`${alias}/`)) return `/private${path}`
  }
  return path
}

function isMissing(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT'
}

function isAlreadyExists(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error
    && ['EEXIST', 'ENOTEMPTY'].includes(String(error.code))
}

function publisherError(code: string, message: string, cause?: unknown): E2EError {
  return new E2EError({ code, category: 'artifact', message, retryable: false, cause })
}
