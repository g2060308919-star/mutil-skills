import { z } from 'zod'
import { canonicalizeJson, digestText } from './common.js'

const DigestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/)
const SafeIdSchema = z.string().min(1).max(256).regex(/^[A-Za-z0-9._:-]+$/)
const TextSchema = z.string().min(1).max(64 * 1024)

const CallerConfirmationSchema = z.object({
  status: z.literal('confirmed-by-caller'),
  contractVersion: z.number().int().positive(),
  confirmedAt: z.string().datetime({ offset: true }),
}).strict()

export const PrdUnderstandingContractHeaderSchema = z.object({
  schemaVersion: z.literal('1.0.0'),
  contractId: SafeIdSchema,
  contractVersion: z.number().int().positive(),
  contractStatus: z.literal('confirmed-by-caller'),
  authorization: CallerConfirmationSchema,
}).strict().superRefine((header, context) => {
  if (header.authorization.contractVersion !== header.contractVersion) context.addIssue({
    code: 'custom', path: ['authorization', 'contractVersion'],
    message: '契约 Header 的授权版本必须等于当前版本',
  })
})

export const PrdUnderstandingSourceSpanSchema = z.object({
  startLine: z.number().int().positive(),
  startColumn: z.number().int().positive(),
  endLine: z.number().int().positive(),
  endColumn: z.number().int().positive(),
}).strict().superRefine((span, context) => {
  if (span.endLine < span.startLine
    || (span.endLine === span.startLine && span.endColumn < span.startColumn)) {
    context.addIssue({ code: 'custom', message: '来源区间结束位置不得早于开始位置' })
  }
})

export function digestPrdUnderstandingQuote(quote: string): string {
  return digestText('prd-understanding-source-quote/v1', quote)
}

const SourceAnchorSchema = z.object({
  sourceId: SafeIdSchema,
  sourceSpan: PrdUnderstandingSourceSpanSchema,
  quote: TextSchema,
  quoteDigest: DigestSchema,
}).strict().superRefine((anchor, context) => {
  if (anchor.quoteDigest !== digestPrdUnderstandingQuote(anchor.quote)) {
    context.addIssue({ code: 'custom', path: ['quoteDigest'], message: '来源引文摘要不匹配' })
  }
})

const SourceFactProvenanceSchema = z.object({
  kind: z.literal('source-fact'),
  anchors: z.array(SourceAnchorSchema).min(1).max(1_000),
}).strict()

const ConfirmedDecisionProvenanceSchema = z.object({
  kind: z.literal('confirmed-decision'),
  decisionId: SafeIdSchema,
  decisionRef: TextSchema,
}).strict()

export const PrdUnderstandingContractNodeSchema = z.object({
  nodeId: SafeIdSchema,
  kind: z.enum(['REQ', 'RULE', 'FLOW']),
  statement: TextSchema,
  provenance: z.discriminatedUnion('kind', [
    SourceFactProvenanceSchema,
    ConfirmedDecisionProvenanceSchema,
  ]),
  responsibility: TextSchema,
  upstreamNodeIds: z.array(SafeIdSchema).max(10_000),
  downstreamNodeIds: z.array(SafeIdSchema).max(10_000),
  acceptanceCriteria: z.array(TextSchema).min(1).max(1_000),
}).strict()

export const PrdUnderstandingRouteSchema = z.object({
  skillName: z.literal('e2e'),
  steps: z.array(z.object({
    stepId: SafeIdSchema,
    inputNodeIds: z.array(SafeIdSchema).min(1).max(10_000),
    output: TextSchema,
    constraints: z.array(TextSchema).max(1_000),
    dependencyStepIds: z.array(SafeIdSchema).max(1_000),
    completionCondition: TextSchema,
  }).strict()).min(1).max(1_000),
}).strict()

export const PrdUnderstandingContractMachineViewSchema = z.object({
  schemaVersion: z.literal('1.0.0'),
  nodes: z.array(PrdUnderstandingContractNodeSchema).min(1).max(10_000),
  pendingQuestions: z.array(z.object({
    questionId: SafeIdSchema,
    question: TextSchema,
    affectedNodeIds: z.array(SafeIdSchema).min(1).max(10_000),
  }).strict()).max(10_000),
  route: PrdUnderstandingRouteSchema,
  authorizedNodeIds: z.array(SafeIdSchema).min(1).max(10_000),
}).strict()

export const PrdUnderstandingProjectionDraftSchema = z.object({
  schemaVersion: z.literal('1.0.0'),
  contractId: SafeIdSchema,
  contractVersion: z.number().int().positive(),
  contractStatus: z.literal('confirmed-by-caller'),
  contractSourceDigest: DigestSchema,
  sourceRevision: DigestSchema,
  sources: z.array(z.object({
    sourceId: SafeIdSchema,
    kind: z.literal('file'),
    ref: TextSchema,
    origin: z.object({
      kind: z.enum(['file', 'url', 'text']),
      ref: TextSchema,
    }).strict(),
    relevance: z.enum(['target', 'necessary-dependency']),
    digest: DigestSchema,
    byteLength: z.number().int().positive().max(16 * 1024 * 1024),
  }).strict()).min(1).max(1_000),
  nodes: z.array(PrdUnderstandingContractNodeSchema).min(1).max(10_000),
  pendingQuestions: z.array(z.object({
    questionId: SafeIdSchema,
    question: TextSchema,
    affectedNodeIds: z.array(SafeIdSchema).min(1).max(10_000),
  }).strict()).max(10_000),
  route: PrdUnderstandingRouteSchema,
  authorization: CallerConfirmationSchema.extend({
    authorizedNodeIds: z.array(SafeIdSchema).min(1).max(10_000),
  }).strict(),
}).strict()

export function digestPrdUnderstandingProjection(input: unknown): string {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return digestText('prd-understanding-projection/v1', canonicalizeJson(input))
  }
  const { projectionDigest: _ignored, ...material } = input as Record<string, unknown>
  return digestText('prd-understanding-projection/v1', canonicalizeJson(material))
}

export const PrdUnderstandingProjectionSchema = PrdUnderstandingProjectionDraftSchema.extend({
  projectionDigest: DigestSchema,
}).strict().superRefine((projection, context) => {
  if (projection.projectionDigest !== digestPrdUnderstandingProjection(projection)) {
    context.addIssue({ code: 'custom', path: ['projectionDigest'], message: '契约执行投影摘要不匹配' })
  }
  const sourceIds = projection.sources.map((source) => source.sourceId)
  if (new Set(sourceIds).size !== sourceIds.length) {
    context.addIssue({ code: 'custom', path: ['sources'], message: 'sourceId 必须唯一' })
  }
  const sourceIdSet = new Set(sourceIds)
  const nodeIds = projection.nodes.map((node) => node.nodeId)
  const nodeIdSet = new Set(nodeIds)
  if (nodeIdSet.size !== nodeIds.length) {
    context.addIssue({ code: 'custom', path: ['nodes'], message: '契约节点 ID 必须唯一' })
  }
  projection.nodes.forEach((node, nodeIndex) => {
    if (node.provenance.kind === 'source-fact') {
      if (!node.provenance.anchors.some((anchor) => anchor.quote === node.statement)) {
        context.addIssue({
          code: 'custom', path: ['nodes', nodeIndex, 'statement'],
          message: 'source-fact 的 statement 必须保留至少一段逐字来源引文',
        })
      }
      node.provenance.anchors.forEach((anchor, anchorIndex) => {
        if (!sourceIdSet.has(anchor.sourceId)) context.addIssue({
          code: 'custom', path: ['nodes', nodeIndex, 'provenance', 'anchors', anchorIndex, 'sourceId'],
          message: '来源锚点必须引用已登记 Source Bundle',
        })
      })
    }
    for (const [field, refs] of [
      ['upstreamNodeIds', node.upstreamNodeIds],
      ['downstreamNodeIds', node.downstreamNodeIds],
    ] as const) refs.forEach((ref, refIndex) => {
      if (!nodeIdSet.has(ref)) context.addIssue({
        code: 'custom', path: ['nodes', nodeIndex, field, refIndex], message: '节点关系必须闭合',
      })
    })
  })
  if (projection.pendingQuestions.length !== 0) context.addIssue({
    code: 'custom', path: ['pendingQuestions'], message: '进入 E2E 前 pendingQuestions 必须为空',
  })
  if (projection.authorization.contractVersion !== projection.contractVersion) context.addIssue({
    code: 'custom', path: ['authorization', 'contractVersion'], message: '授权版本必须等于当前契约版本',
  })
  const authorized = projection.authorization.authorizedNodeIds
  if (new Set(authorized).size !== authorized.length
    || canonicalizeJson([...authorized].sort()) !== canonicalizeJson([...nodeIds].sort())) context.addIssue({
    code: 'custom', path: ['authorization', 'authorizedNodeIds'],
    message: '授权节点集合必须与本次投影节点集合完全一致',
  })
  const routeNodeIds = projection.route.steps.flatMap((step) => step.inputNodeIds)
  if (routeNodeIds.some((nodeId) => !nodeIdSet.has(nodeId))
    || new Set(routeNodeIds).size !== nodeIdSet.size) context.addIssue({
    code: 'custom', path: ['route', 'steps'], message: 'E2E route 必须覆盖全部且仅覆盖契约节点',
  })
  const stepIds = projection.route.steps.map((step) => step.stepId)
  const stepIdSet = new Set(stepIds)
  if (stepIdSet.size !== stepIds.length) context.addIssue({
    code: 'custom', path: ['route', 'steps'], message: 'route stepId 必须唯一',
  })
  projection.route.steps.forEach((step, index) => step.dependencyStepIds.forEach((dependency, depIndex) => {
    if (!stepIdSet.has(dependency) || dependency === step.stepId) context.addIssue({
      code: 'custom', path: ['route', 'steps', index, 'dependencyStepIds', depIndex],
      message: 'route dependency 必须引用其他已登记步骤',
    })
  }))
})

export type PrdUnderstandingProjection = z.infer<typeof PrdUnderstandingProjectionSchema>
export type PrdUnderstandingProjectionDraft = z.infer<typeof PrdUnderstandingProjectionDraftSchema>
export type PrdUnderstandingContractMachineView = z.infer<
  typeof PrdUnderstandingContractMachineViewSchema
>
