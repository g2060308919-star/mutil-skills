import { zodToJsonSchema } from 'zod-to-json-schema'
import { ARTIFACT_TYPES, ArtifactSchemaRegistry, type ArtifactType } from './artifacts.js'

export type ArtifactJsonSchema = ReturnType<typeof zodToJsonSchema> & {
  $id: string
  title: string
  'x-e2e-runtime-validation': { required: true; constraints: string[] }
}

const TYPE_SPECIFIC_RUNTIME_CONSTRAINTS: Partial<Record<ArtifactType, string[]>> = {
  'semantic-generation': ['selectedDigest 必须属于 candidateDigests'],
  'browser-results': ['终态 StepResult 必须包含 actual、Oracle 结果和 evidence'],
  'generation-manifest': [
    'artifactId 与 relativePath 分别唯一',
    'authoritySignature.signedDigest 必须等于 rootDigest',
    'rootDigest、finalizationSnapshotDigest 与 terminalVerdict 必须由本代事实复算',
  ],
}

/**
 * 从运行时 Zod 契约生成可供编辑器、CI 和外部审计器使用的 Draft-07 Schema。
 * 不缓存可变对象，避免调用方修改一次结果后污染后续生成。
 */
export function generateArtifactJsonSchemas(): Record<ArtifactType, ArtifactJsonSchema> {
  return Object.fromEntries(ARTIFACT_TYPES.map((artifactType) => {
    const generated = zodToJsonSchema(ArtifactSchemaRegistry[artifactType], {
      target: 'jsonSchema7',
      $refStrategy: 'none',
      errorMessages: false,
    })
    const schema = {
      ...generated,
      $id: `https://mutil-skills.local/e2e/schemas/${artifactType}.schema.json`,
      title: `${artifactType} artifact`,
      'x-e2e-runtime-validation': {
        required: true as const,
        constraints: [
          'contentDigest、Authority 签名、dependency 与 graph 必须由 validateGeneration 校验',
          ...(TYPE_SPECIFIC_RUNTIME_CONSTRAINTS[artifactType] ?? []),
        ],
      },
    } as ArtifactJsonSchema
    if (artifactType === 'generation-manifest') strengthenGenerationManifestSchema(schema)
    return [artifactType, schema]
  })) as Record<ArtifactType, ArtifactJsonSchema>
}

function strengthenGenerationManifestSchema(schema: ArtifactJsonSchema): void {
  const root = schema as Record<string, unknown>
  const properties = root.properties as Record<string, unknown>
  const content = properties.content as Record<string, unknown>
  const contentProperties = content.properties as Record<string, unknown>
  const artifacts = contentProperties.artifacts as Record<string, unknown>
  const files = contentProperties.files as Record<string, unknown>
  artifacts.uniqueItems = true
  files.uniqueItems = true
  content.allOf = ARTIFACT_TYPES.filter((type) => type !== 'generation-manifest').map((artifactType) => ({
    properties: {
      artifacts: {
        contains: {
          type: 'object',
          properties: { artifactType: { const: artifactType } },
          required: ['artifactType'],
        },
      },
    },
  }))
}
