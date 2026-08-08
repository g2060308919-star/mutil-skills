import { z } from 'zod'
const DigestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/)
const SafeIdSchema = z.string().min(1).max(256).regex(/^[A-Za-z0-9._:-]+$/)
const ExecutorIdSchema = z.string().min(1).max(256).regex(/^[A-Za-z0-9._:-]+\/[A-Za-z0-9._:-]+$/)

export const BrowserExecutorKindV1Schema = z.enum([
  'target-probe', 'preflight', 'read', 'reversible-write', 'injection', 'full-playwright',
])

const BrowserExecutorEffectV1Schema = z.enum(['diagnostic', 'read', 'write', 'injection'])
const EvidenceKindV1Schema = z.enum(['diagnostics', 'screenshot', 'dom', 'trace', 'gateway-audit'])

export const BrowserExecutorDescriptorV1Schema = z.object({
  schemaVersion: z.literal('1.0.0'),
  protocolVersion: z.literal('1.0.0'),
  executorId: ExecutorIdSchema,
  kind: BrowserExecutorKindV1Schema,
  effect: BrowserExecutorEffectV1Schema,
  inputSchemaVersion: z.string().min(1).max(128),
  outputSchemaVersion: z.string().min(1).max(128),
  control: z.object({
    progress: z.literal(true),
    timeout: z.literal('deadline-before-dispatch'),
    cancellation: z.literal('pre-dispatch'),
  }).strict(),
  evidenceKinds: z.array(EvidenceKindV1Schema).max(8),
  retrySafety: z.object({
    beforeDispatch: z.literal('safe'),
    afterDispatch: z.enum(['safe', 'reconcile-required']),
  }).strict(),
  lifecycle: z.object({
    cleanup: z.enum(['not-applicable', 'required']),
    reconcile: z.enum(['not-applicable', 'required-on-unknown']),
  }).strict(),
}).strict().superRefine((value, context) => {
  const write = value.effect === 'write'
  if (write !== ['reversible-write', 'full-playwright'].includes(value.kind)) context.addIssue({
    code: 'custom', path: ['effect'], message: 'write effect 只能且必须用于写执行器',
  })
  if (write && (value.retrySafety.afterDispatch !== 'reconcile-required'
    || value.lifecycle.cleanup !== 'required'
    || value.lifecycle.reconcile !== 'required-on-unknown')) context.addIssue({
    code: 'custom', path: ['lifecycle'], message: '写执行器必须 cleanup，dispatch 后必须 reconcile',
  })
  if (!write && (value.lifecycle.cleanup !== 'not-applicable'
    || value.lifecycle.reconcile !== 'not-applicable')) context.addIssue({
    code: 'custom', path: ['lifecycle'], message: '非写执行器不得声明写生命周期',
  })
})

const EvidenceReferenceV1Schema = z.object({
  kind: EvidenceKindV1Schema,
  uri: z.string().min(1).max(16_384),
  digest: DigestSchema,
}).strict()

export const BrowserExecutorExecutionResultV1Schema = z.object({
  schemaVersion: z.literal('1.0.0'),
  protocolVersion: z.literal('1.0.0'),
  executionId: SafeIdSchema,
  executorId: ExecutorIdSchema,
  kind: BrowserExecutorKindV1Schema,
  runId: SafeIdSchema,
  attemptId: SafeIdSchema,
  status: z.enum(['passed', 'failed', 'input-blocked', 'environment-blocked', 'safety-blocked']),
  outcomeDigest: DigestSchema,
  effectObservation: z.enum(['not-applicable', 'proven-not-applied', 'applied', 'unknown']),
  cleanupStatus: z.enum(['not-applicable', 'verified-clean', 'failed', 'unknown']),
  recovery: z.enum(['none', 'retry', 'reconcile']),
  evidence: z.object({
    materialKinds: z.array(EvidenceKindV1Schema).max(8),
    references: z.array(EvidenceReferenceV1Schema).max(10_000),
  }).strict(),
}).strict().superRefine((value, context) => {
  if (value.effectObservation === 'unknown' && value.recovery !== 'reconcile') context.addIssue({
    code: 'custom', path: ['recovery'], message: 'unknown effect 只能 reconcile',
  })
  if (value.effectObservation !== 'unknown' && value.recovery === 'reconcile') context.addIssue({
    code: 'custom', path: ['recovery'], message: '只有 unknown effect 可 reconcile',
  })
  if (value.effectObservation === 'not-applicable' && value.cleanupStatus !== 'not-applicable') context.addIssue({
    code: 'custom', path: ['cleanupStatus'], message: '无副作用执行不得声明 cleanup 结果',
  })
})

export const BrowserExecutorProgressV1Schema = z.object({
  schemaVersion: z.literal('1.0.0'),
  protocolVersion: z.literal('1.0.0'),
  executionId: SafeIdSchema,
  runId: SafeIdSchema,
  attemptId: SafeIdSchema,
  sequence: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  phase: z.enum(['accepted', 'dispatching', 'executed', 'reconciling', 'completed']),
  at: z.string().datetime(),
}).strict()

export type BrowserExecutorKindV1 = z.infer<typeof BrowserExecutorKindV1Schema>
export type BrowserExecutorDescriptorV1 = z.infer<typeof BrowserExecutorDescriptorV1Schema>
export type BrowserExecutorExecutionResultV1 = z.infer<typeof BrowserExecutorExecutionResultV1Schema>
export type BrowserExecutorProgressV1 = z.infer<typeof BrowserExecutorProgressV1Schema>
