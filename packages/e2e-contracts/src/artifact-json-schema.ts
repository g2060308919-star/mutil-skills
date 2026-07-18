import { zodToJsonSchema } from 'zod-to-json-schema'
import { ARTIFACT_TYPES, ArtifactSchemaRegistry, type ArtifactType } from './artifacts.js'

export type ArtifactJsonSchema = ReturnType<typeof zodToJsonSchema> & {
  $id: string
  title: string
  'x-e2e-runtime-validation': { required: true; constraints: string[] }
}

const TYPE_SPECIFIC_RUNTIME_CONSTRAINTS: Partial<Record<ArtifactType, string[]>> = {
  'execution-contract': [
    'ReadHttpRequest URL 必须是无凭据、无 fragment 的规范 http/https URL，header 名称/值必须满足敏感字段禁用、字节上限与规范顺序',
    'ReadHttpRequest.requestId 必须唯一，redirect requestId 必须唯一、非自引用且属于同一冻结请求集合',
    'actionIntents.requestIds 必须唯一、属于冻结请求集合，且每个 ReadHttpRequest 只能由一个 action 引用',
  ],
  'browser-action-map': [
    'actions.requestIds 必须在 action 内及 action 间唯一，并与 execution-contract 的 ReadHttpRequest/action 投影完全一致',
  ],
  'approval-grants': [
    '审批主体中的 ReadHttpRequest 必须满足规范 URL、敏感 header 禁用、唯一/排序与 redirect 闭包约束',
    'ReadHttpRequest.requestId 与 capability requestId 必须一一覆盖，operation、maxUses 和完整请求投影必须与签名主体一致',
  ],
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
    if (artifactType === 'execution-contract') strengthenExecutionContractReadHttpSchema(schema)
    if (artifactType === 'browser-action-map') strengthenBrowserActionMapReadHttpSchema(schema)
    return [artifactType, schema]
  })) as Record<ArtifactType, ArtifactJsonSchema>
}

const FORBIDDEN_READ_HTTP_HEADERS = [
  'api-key', 'authorization', 'connection', 'content-length', 'cookie', 'host', 'keep-alive',
  'proxy-authenticate', 'proxy-authorization', 'set-cookie', 'te', 'trailer',
  'transfer-encoding', 'upgrade', 'x-api-key', 'x-auth-token',
]

function strengthenExecutionContractReadHttpSchema(schema: ArtifactJsonSchema): void {
  const content = objectProperty(schema, 'content')
  const requests = objectProperty(content, 'readHttpRequests')
  requests.uniqueItems = true
  const request = requests.items as Record<string, unknown>
  const url = objectProperty(request, 'url')
  url.format = 'uri'
  url.pattern = '^https?://'
  url.allOf = [
    { not: { pattern: '^https?://[^/?#]*@' } },
    { not: { pattern: '#' } },
  ]
  const headers = objectProperty(request, 'headers')
  headers.uniqueItems = true
  const header = headers.items as Record<string, unknown>
  const headerName = objectProperty(header, 'name')
  headerName.not = {
    anyOf: [
      { enum: FORBIDDEN_READ_HTTP_HEADERS },
      { pattern: '(^|-)(auth|credential|csrf|secret|session|token)(-|$)' },
    ],
  }
  const headerValue = objectProperty(header, 'value')
  headerValue.maxLength = 8 * 1024
  headerValue.pattern = '^[^\\u0000-\\u0008\\u000A-\\u001F\\u007F]*$'
  const redirect = (objectProperty(request, 'redirectPolicy').anyOf as Array<Record<string, unknown>>)
    .find((candidate) => objectProperty(candidate, 'mode').const === 'follow-approved')
  if (redirect === undefined) throw new Error('execution-contract redirect schema missing')
  objectProperty(redirect, 'requestIds').uniqueItems = true
  const actionIntents = objectProperty(content, 'actionIntents')
  objectProperty(actionIntents.items as Record<string, unknown>, 'requestIds').uniqueItems = true
}

function strengthenBrowserActionMapReadHttpSchema(schema: ArtifactJsonSchema): void {
  const content = objectProperty(schema, 'content')
  const actions = objectProperty(content, 'actions')
  objectProperty(actions.items as Record<string, unknown>, 'requestIds').uniqueItems = true
}

function objectProperty(value: Record<string, unknown>, name: string): Record<string, unknown> {
  const properties = value.properties as Record<string, Record<string, unknown>> | undefined
  const property = properties?.[name]
  if (property === undefined) throw new Error(`JSON Schema property missing: ${name}`)
  return property
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
