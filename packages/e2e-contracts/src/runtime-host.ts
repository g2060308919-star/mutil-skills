import { z } from 'zod'
import { ArtifactTypeSchema } from './artifacts.js'
import { WorkflowNodeSchema } from './workflow.js'

const SafeIdSchema = z.string().min(1).max(256).regex(/^[A-Za-z0-9._:-]+$/)
const DigestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/)
const EmptySchema = z.object({}).strict()
const RunIdPayloadSchema = z.object({ runId: SafeIdSchema }).strict()

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }

const JsonValueSchema: z.ZodType<JsonValue> = z.lazy(() => z.union([
  z.null(),
  z.boolean(),
  z.number().finite(),
  z.string(),
  z.array(JsonValueSchema),
  z.custom<Record<string, JsonValue>>(isPlainJsonObject, 'JSON object 必须是只含可枚举数据属性的普通对象')
    .pipe(z.record(JsonValueSchema)),
]))

const RuntimeRequestHeaderShape = {
  schemaVersion: z.literal('1.0.0'),
  requestId: SafeIdSchema,
  client: z.object({
    name: SafeIdSchema,
    version: z.string().regex(/^\d+\.\d+\.\d+$/),
  }).strict(),
}

const commandSchemas = [
  z.object({
    ...RuntimeRequestHeaderShape,
    command: z.literal('doctor'),
    payload: EmptySchema,
  }).strict(),
  z.object({
    ...RuntimeRequestHeaderShape,
    command: z.literal('create-run'),
    projectRoot: z.string().min(1),
    payload: z.object({
      assetId: SafeIdSchema,
      prdSource: z.object({ kind: z.literal('file'), path: z.string().min(1) }).strict(),
      projectPolicyPath: z.string().min(1),
    }).strict(),
  }).strict(),
  z.object({
    ...RuntimeRequestHeaderShape,
    command: z.literal('submit-candidate'),
    projectRoot: z.string().min(1),
    payload: z.object({
      runId: SafeIdSchema,
      expectedState: WorkflowNodeSchema,
      artifactType: ArtifactTypeSchema,
      candidate: JsonValueSchema,
    }).strict(),
  }).strict(),
  z.object({
    ...RuntimeRequestHeaderShape,
    command: z.literal('open-approval'),
    projectRoot: z.string().min(1),
    payload: z.object({
      runId: SafeIdSchema,
      approvalType: z.enum(['scope', 'lineage', 'discovery', 'execution', 'privacy']),
    }).strict(),
  }).strict(),
  z.object({
    ...RuntimeRequestHeaderShape,
    command: z.literal('execute-run'),
    projectRoot: z.string().min(1),
    payload: RunIdPayloadSchema,
  }).strict(),
  z.object({
    ...RuntimeRequestHeaderShape,
    command: z.literal('resume-run'),
    projectRoot: z.string().min(1),
    payload: z.object({ runId: SafeIdSchema, decision: JsonValueSchema }).strict(),
  }).strict(),
  z.object({
    ...RuntimeRequestHeaderShape,
    command: z.literal('get-status'),
    projectRoot: z.string().min(1),
    payload: RunIdPayloadSchema,
  }).strict(),
  z.object({
    ...RuntimeRequestHeaderShape,
    command: z.literal('render-report'),
    projectRoot: z.string().min(1),
    payload: RunIdPayloadSchema,
  }).strict(),
] as const

export const RuntimeRequestEnvelopeSchema = z.discriminatedUnion('command', commandSchemas)

export const RuntimeErrorSchema = z.object({
  code: z.string().regex(/^E2E_[A-Z0-9_]+$/),
  category: z.enum(['input', 'environment', 'safety', 'automation', 'artifact', 'migration', 'internal']),
  terminalState: z.enum([
    'input-blocked',
    'environment-blocked',
    'safety-blocked',
    'automation-blocked',
    'artifact-blocked',
    'migration-required',
  ]),
  message: z.string().min(1),
  retryable: z.boolean(),
  resumeState: WorkflowNodeSchema.optional(),
  details: z.record(z.unknown()).optional(),
}).strict()

export const RuntimeDoctorProbeSchema = z.object({
  status: z.enum(['passed', 'blocked', 'not-installed']),
  reasonCode: z.string().regex(/^E2E_[A-Z0-9_]+$/),
  proofDigest: DigestSchema.optional(),
  remediation: z.string().min(1),
}).strict()

export const RuntimeDoctorReportSchema = z.object({
  ready: z.boolean(),
  runtimeVersion: z.string().regex(/^\d+\.\d+\.\d+$/),
  installationDigest: DigestSchema,
  probes: z.record(RuntimeDoctorProbeSchema),
}).strict()

export const RuntimeResponseEnvelopeSchema = z.object({
  schemaVersion: z.literal('1.0.0'),
  requestId: SafeIdSchema,
  runtime: z.object({
    version: z.string().regex(/^\d+\.\d+\.\d+$/),
    installationDigest: DigestSchema,
  }).strict(),
  ok: z.boolean(),
  result: z.unknown().optional(),
  error: RuntimeErrorSchema.optional(),
}).strict().superRefine((value, context) => {
  if (value.ok === (value.error !== undefined) || value.ok !== (value.result !== undefined)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'response 必须且只能包含 result 或 error',
    })
  }
})

export type RuntimeRequestEnvelope = z.infer<typeof RuntimeRequestEnvelopeSchema>
export type RuntimeResponseEnvelope = z.infer<typeof RuntimeResponseEnvelopeSchema>
export type RuntimeError = z.infer<typeof RuntimeErrorSchema>
export type RuntimeDoctorProbe = z.infer<typeof RuntimeDoctorProbeSchema>
export type RuntimeDoctorReport = z.infer<typeof RuntimeDoctorReportSchema>

function isPlainJsonObject(value: unknown): value is Record<string, JsonValue> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype) return false
  return Reflect.ownKeys(value).every((key) => {
    if (typeof key !== 'string') return false
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    return descriptor?.enumerable === true && 'value' in descriptor
  })
}
