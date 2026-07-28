import {
  ArtifactSchemaRegistry,
  E2EError,
  PrdUnderstandingProjectionDraftSchema,
  PrdUnderstandingProjectionSchema,
  canonicalizeJson,
  digestPrdUnderstandingProjection,
  type ArtifactDocument,
  type ArtifactType,
  type PrdUnderstandingProjection,
} from '@mutil-skills/e2e-contracts'
import type { RuntimeRunSnapshot } from './run-store.js'
import {
  PrdSourceBundleSnapshotSchema,
  PrdUnderstandingContractFactSchema,
  PrdUnderstandingPreparedFactSchema,
} from './local-approval-confirmations.js'

export function assertPrdUnderstandingCandidate(
  candidate: unknown,
  snapshot: Pick<RuntimeRunSnapshot, 'artifactDigests' | 'trustedExecutionFacts'>,
): void {
  const parsedCandidate = ArtifactSchemaRegistry['prd-request'].parse(candidate)
  const projection = parsedCandidate.content.understanding
  const prepared = PrdUnderstandingPreparedFactSchema.safeParse(
    snapshot.trustedExecutionFacts['prd-understanding-prepared'],
  )
  if (!prepared.success
    || canonicalizeJson(prepared.data.projection) !== canonicalizeJson(projection)) {
    throw understandingError(
      'E2E_RUNTIME_UNDERSTANDING_PREPARED_MISMATCH',
      'prd-request 必须逐字复用当前 Run 唯一 prepared projection',
    )
  }
  assertProjectionAgainstSnapshot(projection, snapshot)
  const descriptorById = new Map(parsedCandidate.content.sourceDescriptors
    .map((descriptor) => [descriptor.sourceId, descriptor]))
  if (descriptorById.size !== projection.sources.length) {
    throw understandingError(
      'E2E_RUNTIME_UNDERSTANDING_SOURCE_SET_MISMATCH',
      'prd-request sourceDescriptors 必须与 understand-prd Source Bundle 完全一致',
    )
  }
  for (const source of projection.sources) {
    const descriptor = descriptorById.get(source.sourceId)
    if (descriptor === undefined || descriptor.kind !== source.kind || descriptor.ref !== source.ref) {
      throw understandingError(
        'E2E_RUNTIME_UNDERSTANDING_SOURCE_SET_MISMATCH',
        `来源 ${source.sourceId} 未与 prd-request sourceDescriptors 闭合`,
      )
    }
  }
}

export function preparePrdUnderstandingProjection(
  draft: unknown,
  snapshot: Pick<RuntimeRunSnapshot, 'artifactDigests' | 'trustedExecutionFacts'>,
): PrdUnderstandingProjection {
  let draftByteLength: number
  try {
    draftByteLength = Buffer.byteLength(canonicalizeJson(draft), 'utf8')
  } catch {
    throw understandingError(
      'E2E_RUNTIME_UNDERSTANDING_SCHEMA_INVALID',
      'understand-prd execution projection 必须是 canonical JSON',
    )
  }
  if (draftByteLength > 2 * 1024 * 1024) throw understandingError(
    'E2E_RUNTIME_UNDERSTANDING_TOO_LARGE',
    'understand-prd execution projection 超过 2 MiB',
  )
  const parsedDraft = PrdUnderstandingProjectionDraftSchema.safeParse(draft)
  if (!parsedDraft.success) throw understandingError(
    'E2E_RUNTIME_UNDERSTANDING_SCHEMA_INVALID',
    'understand-prd execution projection 不符合严格 schema',
  )
  const prepared = {
    ...parsedDraft.data,
    projectionDigest: digestPrdUnderstandingProjection(parsedDraft.data),
  }
  const parsedProjection = PrdUnderstandingProjectionSchema.safeParse(prepared)
  if (!parsedProjection.success) throw understandingError(
    'E2E_RUNTIME_UNDERSTANDING_SCHEMA_INVALID',
    'understand-prd execution projection 未通过闭包校验',
  )
  const projection = parsedProjection.data
  const contract = PrdUnderstandingContractFactSchema.safeParse(
    snapshot.trustedExecutionFacts['prd-understanding-contract'],
  )
  if (!contract.success) throw new E2EError({
    code: 'E2E_RUNTIME_UNDERSTANDING_MIGRATION_REQUIRED',
    category: 'artifact',
    message: 'E2E_RUNTIME_UNDERSTANDING_MIGRATION_REQUIRED: 旧 Run 未冻结 requirements contract，请新建 Run',
    retryable: false,
  })
  if (projection.contractId !== contract.data.header.contractId
    || projection.contractVersion !== contract.data.header.contractVersion
    || projection.contractStatus !== contract.data.header.contractStatus
    || projection.authorization.status !== contract.data.header.authorization.status
    || projection.authorization.contractVersion !== contract.data.header.authorization.contractVersion
    || projection.authorization.confirmedAt !== contract.data.header.authorization.confirmedAt
    || projection.contractSourceDigest !== contract.data.sourceDigest) {
    throw understandingError(
      'E2E_RUNTIME_UNDERSTANDING_CONTRACT_REVISION_MISMATCH',
      'execution projection 未绑定 create-run 冻结的当前 requirements contract',
    )
  }
  const projectedMachineView = {
    schemaVersion: '1.0.0' as const,
    nodes: projection.nodes,
    pendingQuestions: projection.pendingQuestions,
    route: projection.route,
    authorizedNodeIds: projection.authorization.authorizedNodeIds,
  }
  if (canonicalizeJson(projectedMachineView) !== canonicalizeJson(contract.data.machineView)) {
    throw understandingError(
      'E2E_RUNTIME_UNDERSTANDING_CONTRACT_BODY_MISMATCH',
      'execution projection 的节点、决定、route 或授权集合与冻结 requirements contract 正文不一致',
    )
  }
  assertProjectionAgainstSnapshot(projection, snapshot)
  return projection
}

function assertProjectionAgainstSnapshot(
  projection: PrdUnderstandingProjection,
  snapshot: Pick<RuntimeRunSnapshot, 'artifactDigests' | 'trustedExecutionFacts'>,
): void {
  const bundle = PrdSourceBundleSnapshotSchema.parse(
    snapshot.trustedExecutionFacts['prd-source-bundle'],
  )
  if (projection.sourceRevision !== snapshot.artifactDigests['prd-source']
    || projection.sourceRevision !== bundle.sourceRevision) {
    throw understandingError(
      'E2E_RUNTIME_UNDERSTANDING_REVISION_MISMATCH',
      'understand-prd 投影未绑定当前冻结 Source Revision',
    )
  }

  const frozenById = new Map(bundle.sources.map((source) => [source.sourceId, source]))
  if (frozenById.size !== projection.sources.length) {
    throw understandingError(
      'E2E_RUNTIME_UNDERSTANDING_SOURCE_SET_MISMATCH',
      'understand-prd Source Bundle 必须与 Runtime 冻结来源集合完全一致',
    )
  }
  for (const source of projection.sources) {
    const frozen = frozenById.get(source.sourceId)
    if (frozen === undefined
      || source.kind !== frozen.kind
      || source.ref !== frozen.sourceRef
      || canonicalizeJson(source.origin) !== canonicalizeJson(frozen.origin)
      || source.relevance !== frozen.relevance
      || source.digest !== frozen.normalizedDigest || source.byteLength !== frozen.byteLength) {
      throw understandingError(
        'E2E_RUNTIME_UNDERSTANDING_SOURCE_SET_MISMATCH',
        `来源 ${source.sourceId} 未与 Runtime 冻结 bytes 闭合`,
      )
    }
  }

  for (const node of projection.nodes) {
    if (node.provenance.kind !== 'source-fact') continue
    for (const anchor of node.provenance.anchors) {
      const frozen = frozenById.get(anchor.sourceId)
      if (frozen === undefined) throw understandingError(
        'E2E_RUNTIME_UNDERSTANDING_SOURCE_REF_MISSING',
        `节点 ${node.nodeId} 引用了未冻结来源 ${anchor.sourceId}`,
      )
      const actual = sourceTextAtSpan(frozen.normalizedText, anchor.sourceSpan)
      if (actual !== anchor.quote) throw understandingError(
        'E2E_RUNTIME_UNDERSTANDING_SOURCE_QUOTE_MISMATCH',
        `节点 ${node.nodeId} 的 source-fact 与冻结原文不一致`,
      )
    }
  }
}

export function assertPrdUnderstandingLinkedCandidate(
  artifactType: ArtifactType,
  candidate: ArtifactDocument,
  snapshot: Pick<RuntimeRunSnapshot, 'frozenArtifacts' | 'trustedExecutionFacts'>,
): void {
  if (artifactType !== 'prd-manifest'
    && artifactType !== 'requirement-model'
    && artifactType !== 'interaction-flow') return
  const request = ArtifactSchemaRegistry['prd-request'].safeParse(snapshot.frozenArtifacts['prd-request'])
  if (!request.success) throw understandingError(
    'E2E_RUNTIME_UNDERSTANDING_PROJECTION_MISSING',
    '语义资产必须引用已冻结的 understand-prd 执行投影',
  )
  const projection = request.data.content.understanding
  if (artifactType === 'prd-manifest') {
    const manifest = ArtifactSchemaRegistry['prd-manifest'].parse(candidate).content
    const bundle = PrdSourceBundleSnapshotSchema.parse(snapshot.trustedExecutionFacts['prd-source-bundle'])
    const frozenById = new Map(bundle.sources.map((source) => [source.sourceId, source]))
    for (const clause of manifest.clauses) {
      const frozen = frozenById.get(clause.sourceId)
      if (frozen === undefined
        || sourceTextAtSpan(frozen.normalizedText, clause.sourceSpan) !== clause.originalText) {
        throw understandingError(
          'E2E_RUNTIME_PRD_CLAUSE_SOURCE_MISMATCH',
          `Clause ${clause.clauseId} 未与冻结 Source Bundle 原文闭合`,
        )
      }
    }
    for (const node of projection.nodes) {
      if (node.provenance.kind !== 'source-fact') continue
      for (const anchor of node.provenance.anchors) {
        const matched = manifest.clauses.some((clause) => clause.sourceId === anchor.sourceId
          && clause.originalText === anchor.quote
          && JSON.stringify(clause.sourceSpan) === JSON.stringify(anchor.sourceSpan))
        if (!matched) throw understandingError(
          'E2E_RUNTIME_UNDERSTANDING_ANCHOR_UNMAPPED',
          `契约节点 ${node.nodeId} 的来源锚点未映射为 Clause`,
        )
      }
    }
    return
  }
  if (artifactType === 'requirement-model') {
    const model = ArtifactSchemaRegistry['requirement-model'].parse(candidate).content
    const nodeIds = new Set(projection.nodes.map((node) => node.nodeId))
    const requirementMappings = model.requirements.flatMap((requirement) => {
      assertContractNodeRefs(requirement.contractNodeIds, nodeIds, `Requirement ${requirement.reqId}`)
      return requirement.contractNodeIds
    })
    const ruleMappings = model.requirements.flatMap((requirement) =>
      requirement.rules.flatMap((rule) => {
        assertContractNodeRefs(rule.contractNodeIds, nodeIds, `Rule ${rule.ruleId}`)
        return rule.contractNodeIds
      }))
    for (const node of projection.nodes.filter((item) => item.kind === 'REQ')) {
      if (!requirementMappings.includes(node.nodeId)) throw understandingError(
        'E2E_RUNTIME_UNDERSTANDING_NODE_UNMAPPED',
        `契约节点 ${node.nodeId} 未映射到 Requirement`,
      )
    }
    for (const node of projection.nodes.filter((item) => item.kind === 'RULE')) {
      if (!ruleMappings.includes(node.nodeId)) throw understandingError(
        'E2E_RUNTIME_UNDERSTANDING_NODE_UNMAPPED',
        `契约节点 ${node.nodeId} 未映射到 Rule`,
      )
    }
    const expectedCriteria = new Set(projection.nodes.flatMap((node) =>
      node.acceptanceCriteria.map((_criterion, criterionIndex) => `${node.nodeId}:${criterionIndex}`)))
    const mappedCriteria = model.requirements.flatMap((requirement) =>
      requirement.observableOutcomes.flatMap((outcome) => outcome.contractAcceptanceCriteria ?? []))
    const mappedCriterionKeys = mappedCriteria.map((ref) => `${ref.nodeId}:${ref.criterionIndex}`)
    if (new Set(mappedCriterionKeys).size !== mappedCriterionKeys.length
      || expectedCriteria.size !== mappedCriterionKeys.length
      || mappedCriterionKeys.some((key) => !expectedCriteria.has(key))) {
      throw understandingError(
        'E2E_RUNTIME_UNDERSTANDING_ACCEPTANCE_UNMAPPED',
        'Requirement Model 的 Oracle 必须完整且唯一映射全部契约验收条件',
      )
    }
    return
  }
  const flow = ArtifactSchemaRegistry['interaction-flow'].parse(candidate).content
  const nodeIds = new Set(projection.nodes.map((node) => node.nodeId))
  const flowMappings = flow.flows.flatMap((item) => {
    assertContractNodeRefs(item.contractNodeIds, nodeIds, `Flow ${item.flowId}`)
    return item.contractNodeIds
  })
  for (const node of projection.nodes.filter((item) => item.kind === 'FLOW')) {
    if (!flowMappings.includes(node.nodeId)) throw understandingError(
      'E2E_RUNTIME_UNDERSTANDING_NODE_UNMAPPED',
      `契约节点 ${node.nodeId} 未映射到 Interaction Flow`,
    )
  }
}

function assertContractNodeRefs(
  refs: string[] | undefined,
  nodeIds: Set<string>,
  owner: string,
): asserts refs is string[] {
  if (refs === undefined || refs.length === 0 || refs.some((nodeId) => !nodeIds.has(nodeId))) {
    throw understandingError(
      'E2E_RUNTIME_UNDERSTANDING_DERIVED_ASSET_UNBOUND',
      `${owner} 必须引用当前 requirements contract 中的节点`,
    )
  }
}

function sourceTextAtSpan(
  text: string,
  span: { startLine: number; startColumn: number; endLine: number; endColumn: number },
): string {
  const lines = text.replace(/\r\n?/g, '\n').split('\n')
  if (span.startLine > lines.length || span.endLine > lines.length) {
    throw understandingError('E2E_RUNTIME_UNDERSTANDING_SOURCE_SPAN_INVALID', '来源区间超出冻结原文')
  }
  const selected = lines.slice(span.startLine - 1, span.endLine)
  const first = Array.from(selected[0] ?? '')
  const last = Array.from(selected.at(-1) ?? '')
  if (span.startColumn > first.length + 1 || span.endColumn > last.length) {
    throw understandingError('E2E_RUNTIME_UNDERSTANDING_SOURCE_SPAN_INVALID', '来源列区间超出冻结原文')
  }
  if (selected.length === 1) return first.slice(span.startColumn - 1, span.endColumn).join('')
  selected[0] = first.slice(span.startColumn - 1).join('')
  selected[selected.length - 1] = last.slice(0, span.endColumn).join('')
  return selected.join('\n')
}

function understandingError(code: string, message: string): Error {
  return new E2EError({ code, category: 'input', message: `${code}: ${message}`, retryable: false })
}
