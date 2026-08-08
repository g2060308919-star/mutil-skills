import { z } from 'zod'

const DigestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/)
const StableSemverSchema = z.string().regex(/^\d+\.\d+\.\d+$/)

const MigrationSourceSchemaVersionsSchema = z.tuple([
  z.literal('1.0.0'),
  z.literal('1.1.0'),
  z.literal('1.2.0'),
  z.literal('1.3.0'),
  z.literal('1.4.0'),
  z.literal('1.5.0'),
  z.literal('1.6.0'),
  z.literal('1.7.0'),
])

const ExecutorCapabilitiesSchema = z.tuple([
  z.literal('target-probe'),
  z.literal('preflight'),
  z.literal('read'),
  z.literal('reversible-write'),
  z.literal('injection'),
  z.literal('full-playwright'),
])

/**
 * Runtime 只读兼容事实。它描述当前实现已经证明的边界，不负责选择、安装或升级 Runtime。
 */
export const RuntimeCompatibilityDescriptorV1Schema = z.object({
  schemaVersion: z.literal('1.0.0'),
  runtime: z.object({
    packageName: z.literal('@mutil-skills/e2e-runtime'),
    packageVersion: StableSemverSchema,
    nodeRange: z.literal('>=22.13.0'),
    protocol: z.object({
      major: z.literal(1),
      envelopeSchemaVersion: z.literal('1.0.0'),
    }).strict(),
  }).strict(),
  state: z.object({
    currentSnapshotSchemaVersion: z.literal('1.8.0'),
    migrationSourceSchemaVersions: MigrationSourceSchemaVersionsSchema,
    restrictions: z.tuple([z.object({
      schemaVersion: z.literal('1.0.0'),
      condition: z.literal('created-workflow-only'),
    }).strict()]),
  }).strict(),
  artifacts: z.object({
    schemaSetDigest: DigestSchema,
  }).strict(),
  prd: z.object({
    designSchemaVersions: z.tuple([z.literal('1.0.0'), z.literal('2.0.0')]),
  }).strict(),
  executor: z.object({
    boundary: z.literal('capability-branded'),
    capabilities: ExecutorCapabilitiesSchema,
  }).strict(),
  runBinding: z.object({
    mode: z.literal('exact-installation-digest'),
    installationDigest: DigestSchema,
    automaticUpgrade: z.literal(false),
  }).strict(),
}).strict()

export type RuntimeCompatibilityDescriptorV1 = z.infer<typeof RuntimeCompatibilityDescriptorV1Schema>
