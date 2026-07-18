import { lstat, readFile, realpath } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import { ArtifactSchemaRegistry, E2EError } from '@mutil-skills/e2e-contracts'
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
    return {
      active: {
        generationId: active.generationId,
        generationDigest: active.generationDigest,
        terminalVerdict: active.terminalVerdict,
      },
      rendered: renderCompleteReport(parsed.data),
    }
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

function publisherError(code: string, message: string, cause?: unknown): E2EError {
  return new E2EError({ code, category: 'artifact', message, retryable: false, cause })
}
