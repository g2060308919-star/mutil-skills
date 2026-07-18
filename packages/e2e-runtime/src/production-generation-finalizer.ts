import {
  canonicalizeJson,
  digestText,
  E2EError,
  type RuntimeProvenance,
  type QuarantineActor,
} from '@mutil-skills/e2e-contracts'
import type {
  CompleteArtifactDraft,
  CompleteGenerationAuthority,
  CompleteGenerationContext,
} from '@mutil-skills/e2e-engine'
import type { GatewayPublicationAudit } from '@mutil-skills/e2e-gateway'
import type { TrustedCompilerInput } from '@mutil-skills/e2e-playwright-runtime'
import type { EncryptedQuarantine } from '@mutil-skills/e2e-engine'
import { GenerationAssembler, type RuntimeCleanupResult, type SanitizedRuntimeEvidence } from './generation-assembler.js'
import { ProjectPublisher } from './project-publisher.js'
import { RegressionPublisher, type RegressionPublicationResult } from './regression-publisher.js'
import {
  authorizeRuntimeGenerationFinalizer,
  type RuntimeGenerationFinalizationCapability,
  type RuntimeGenerationFinalizationInput,
  type RuntimeGenerationFinalizationResult,
} from './runtime-generation-finalizer.js'
import type { RuntimeExecutionBatch } from './runtime-execution-batch.js'

export interface PreparedRuntimeGenerationMaterial {
  compilerInput: TrustedCompilerInput
  bind(input: { regression: RegressionPublicationResult; fencingToken: number }): {
    context: CompleteGenerationContext
    semanticDrafts: Record<string, CompleteArtifactDraft>
    execution: RuntimeExecutionBatch
    gatewayAudit: GatewayPublicationAudit
    evidence: SanitizedRuntimeEvidence[]
    cleanup: RuntimeCleanupResult[]
    provenance: RuntimeProvenance
    authorities: CompleteGenerationAuthority
    reportPresentation?: ConstructorParameters<typeof GenerationAssembler>[0]['reportPresentation']
    verifiers?: Parameters<GenerationAssembler['finalize']>[0]['verifiers']
  }
  /** 清零内存中的 sanitized/raw 中间 bytes；不得删除 durable quarantine key。 */
  release(): void | Promise<void>
}

export interface RuntimeFinalizationMaterialProvider {
  /**
   * 只能从冻结 semantic artifacts、Runtime trusted facts 与加密 Quarantine 读取并脱敏；
   * 不得接收 RPC payload 中的 drafts、verdict、digest 或 evidence bytes。
   */
  prepare(input: RuntimeGenerationFinalizationInput): Promise<PreparedRuntimeGenerationMaterial>
}

/**
 * finalize-run 的 production transaction：sanitizer/material → sandboxed regression compile →
 * sole GenerationAssembler → staged audit/active commit → active readback → crypto-erasure。
 */
export class ProductionGenerationFinalizer {
  constructor(private readonly dependencies: {
    materialProvider: RuntimeFinalizationMaterialProvider
    regressionPublisher: RegressionPublisher
    assembler: GenerationAssembler
    projectPublisher: ProjectPublisher
    quarantine: Pick<EncryptedQuarantine, 'destroyAfterPublication' | 'resumePendingErasure'>
  }) {}

  capability(): RuntimeGenerationFinalizationCapability {
    return authorizeRuntimeGenerationFinalizer(async (input) => await this.finalize(input))
  }

  private async finalize(
    input: RuntimeGenerationFinalizationInput,
  ): Promise<RuntimeGenerationFinalizationResult> {
    if (input.recovery) return await this.reconcileCommittedPublication(input)
    const prepared = await this.dependencies.materialProvider.prepare(input)
    try {
      const regression = await this.dependencies.regressionPublisher.compile({
        compilerInput: prepared.compilerInput,
      })
      const active = await this.dependencies.projectPublisher.publish({
        assetId: input.snapshot.assetId,
        generationId: input.snapshot.runId,
        prepare: ({ fencingToken }) => {
          const material = prepared.bind({ regression, fencingToken })
          return this.dependencies.assembler.finalize({
            context: material.context,
            semanticDrafts: material.semanticDrafts as never,
            execution: material.execution,
            gatewayAudit: material.gatewayAudit,
            evidence: material.evidence,
            cleanup: material.cleanup,
            regression,
            provenance: material.provenance,
            authorities: material.authorities,
            ...(material.reportPresentation === undefined ? {} : {
              reportPresentation: material.reportPresentation,
            }),
            ...(material.verifiers === undefined ? {} : { verifiers: material.verifiers }),
          })
        },
      })
      const readback = await this.dependencies.projectPublisher.readActiveGeneration(
        input.snapshot.assetId, input.snapshot.runId,
      )
      if (readback === undefined || readback.generationDigest !== active.generationDigest) {
        throw finalizationError('E2E_RUNTIME_FINALIZATION_ACTIVE_READBACK_MISMATCH')
      }
      await this.dependencies.quarantine.destroyAfterPublication({
        runId: input.snapshot.runId,
        generationDigest: active.generationDigest,
        actor: publisherActor(),
      })
      return resultFor(active, input.snapshot.runId)
    } finally {
      await prepared.release()
    }
  }

  private async reconcileCommittedPublication(
    input: RuntimeGenerationFinalizationInput,
  ): Promise<RuntimeGenerationFinalizationResult> {
    const active = await this.dependencies.projectPublisher.readActiveGeneration(
      input.snapshot.assetId, input.snapshot.runId,
    )
    if (active === undefined) throw finalizationError(
      'E2E_RUNTIME_FINALIZATION_PRIVACY_RECOVERY_REQUIRED',
      '崩溃后没有已提交 active generation；只能由隐私审批恢复或销毁 Quarantine，禁止自动重发',
    )
    await this.dependencies.quarantine.resumePendingErasure(publisherActor())
    return resultFor(active, input.snapshot.runId)
  }
}

function resultFor(active: {
  generationId: string
  generationDigest: string
  terminalVerdict: RuntimeGenerationFinalizationResult['terminalVerdict']
}, runId: string): RuntimeGenerationFinalizationResult {
  const activeReadbackDigest = digestText('runtime-active-readback/v1', canonicalizeJson(active))
  return {
    generationId: active.generationId,
    generationDigest: active.generationDigest,
    terminalVerdict: active.terminalVerdict,
    activeReadbackDigest,
    quarantineDispositionDigest: digestText('runtime-quarantine-disposition/v1', canonicalizeJson({
      runId, generationDigest: active.generationDigest, status: 'crypto-erased-or-durable-pending-erasure',
    })),
  }
}

function publisherActor(): QuarantineActor {
  return { subject: 'runtime:project-publisher', roles: ['e2e-publisher'] }
}

function finalizationError(code: string, message = code): E2EError {
  return new E2EError({ code, category: 'artifact', message, retryable: false })
}
