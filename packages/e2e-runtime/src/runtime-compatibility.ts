import {
  RuntimeCompatibilityDescriptorV1Schema,
  type RuntimeCompatibilityDescriptorV1,
} from '@mutil-skills/e2e-contracts'
import { RUNTIME_PACKAGE_VERSION } from './protocol.js'
import { RuntimeStateMigrationRegistry } from './runtime-state-migration.js'

const CURRENT_SNAPSHOT_SCHEMA_VERSION = '1.8.0' as const

/**
 * 把 Runtime 当前已经证明的兼容边界投影为严格、只读事实。
 * 该函数不联网、不选择版本、不改变 current 指针，也不迁移活跃 Run。
 */
export function describeRuntimeCompatibility(input: {
  artifactSchemaSetDigest: string
  runtimeInstallationDigest: string
}): RuntimeCompatibilityDescriptorV1 {
  return RuntimeCompatibilityDescriptorV1Schema.parse({
    schemaVersion: '1.0.0',
    runtime: {
      packageName: '@mutil-skills/e2e-runtime',
      packageVersion: RUNTIME_PACKAGE_VERSION,
      nodeRange: '>=22.13.0',
      protocol: { major: 1, envelopeSchemaVersion: '1.0.0' },
    },
    state: {
      currentSnapshotSchemaVersion: CURRENT_SNAPSHOT_SCHEMA_VERSION,
      migrationSourceSchemaVersions: Object.keys(RuntimeStateMigrationRegistry),
      restrictions: [{ schemaVersion: '1.0.0', condition: 'created-workflow-only' }],
    },
    artifacts: { schemaSetDigest: input.artifactSchemaSetDigest },
    prd: { designSchemaVersions: ['1.0.0', '2.0.0'] },
    executor: {
      boundary: 'capability-branded',
      capabilities: [
        'target-probe',
        'preflight',
        'read',
        'reversible-write',
        'injection',
        'full-playwright',
      ],
    },
    runBinding: {
      mode: 'exact-installation-digest',
      installationDigest: input.runtimeInstallationDigest,
      automaticUpgrade: false,
    },
  })
}
