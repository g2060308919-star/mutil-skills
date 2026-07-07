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

export const SkillRequirementSchema = TestingFoundationRequirementSchema

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
