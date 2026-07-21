import { z } from 'zod'

const SafeIdSchema = z.string().min(1).max(256).regex(/^[A-Za-z0-9._:-]+$/)
const DigestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/)

export const ApprovalExecutionBindingSchema = z.object({
  runId: SafeIdSchema,
  installationDigest: DigestSchema,
  approvalType: z.enum(['discovery', 'execution']),
  subjectDigest: DigestSchema,
}).strict()

export const ApprovalFinalizationAcknowledgementSchema = z.object({
  finalizationId: SafeIdSchema,
  requestDigest: DigestSchema,
  grantId: SafeIdSchema,
  approvalBinding: ApprovalExecutionBindingSchema,
}).strict()

export type ApprovalExecutionBinding = z.infer<typeof ApprovalExecutionBindingSchema>
export type ApprovalFinalizationAcknowledgement = z.infer<typeof ApprovalFinalizationAcknowledgementSchema>
