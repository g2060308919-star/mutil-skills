import { z } from 'zod'

export const TemplateReferenceSchema = z.object({
  id: z.string().min(1),
})

export const TestingFoundationRequirementSchema = z.object({
  capability: z.literal('foundation.testing'),
  satisfiedBy: z.array(z.string().min(1)).min(1),
  whenMissing: z.object({
    action: z.literal('prompt-install'),
    package: z.string().min(1),
    import: z.string().min(1),
  }),
})

export const E2ERuntimeCapabilitySchema = z.enum([
  'e2e.contracts',
  'e2e.engine',
  'e2e.authority',
  'e2e.gateway',
  'browser.chromium',
  'e2e.report',
  'e2e.sanitizer',
  'artifact.posix-local-fs',
])

export const E2ERuntimeRequirementSchema = z.object({
  capability: E2ERuntimeCapabilitySchema,
  satisfiedBy: z.array(z.string().min(1)).min(1),
  whenMissing: z.object({
    action: z.literal('block'),
    terminalState: z.enum([
      'input-blocked', 'environment-blocked', 'safety-blocked', 'artifact-blocked', 'migration-required',
    ]),
    reasonCode: z.string().min(1).regex(/^E2E_[A-Z0-9_]+$/),
  }),
})

export const SkillRequirementSchema = z.discriminatedUnion('capability', [
  TestingFoundationRequirementSchema,
  E2ERuntimeRequirementSchema,
])

export const SkillManifestSchema = z.object({
  $schema: z.string().optional(),
  id: z.string().min(1),
  name: z.string().min(1),
  source: z.object({
    type: z.literal('github'),
    url: z.string().url(),
    rawUrl: z.string().url(),
    ref: z.string().min(1),
  }),
  requires: z.array(SkillRequirementSchema),
  templateReferences: z.array(TemplateReferenceSchema).optional().default([]),
})

export type TemplateReference = z.infer<typeof TemplateReferenceSchema>
export type TestingFoundationRequirement = z.infer<typeof TestingFoundationRequirementSchema>
export type E2ERuntimeCapability = z.infer<typeof E2ERuntimeCapabilitySchema>
export type E2ERuntimeRequirement = z.infer<typeof E2ERuntimeRequirementSchema>
export type SkillRequirement = z.infer<typeof SkillRequirementSchema>
export type SkillManifest = z.infer<typeof SkillManifestSchema>

export interface ValidationError {
  path: string
  message: string
}

export type ValidationResult<T> =
  | { success: true; data: T }
  | { success: false; errors: ValidationError[] }

export function parseSkillManifest(input: unknown): SkillManifest {
  const result = validateSkillManifest(input)
  if (!result.success) {
    const message = result.errors.map((error) => `${error.path}: ${error.message}`).join('; ')
    throw new Error(`skill manifest 无效：${message}`)
  }
  return result.data
}

export function validateSkillManifest(input: unknown): ValidationResult<SkillManifest> {
  const result = SkillManifestSchema.safeParse(input)
  if (result.success) {
    return { success: true, data: result.data }
  }
  return {
    success: false,
    errors: result.error.issues.map((issue) => ({
      path: issue.path.join('.'),
      message: issue.message,
    })),
  }
}
