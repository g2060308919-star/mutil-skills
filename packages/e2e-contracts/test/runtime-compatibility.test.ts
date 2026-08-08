import { describe, expect, test } from 'vitest'
import { RuntimeCompatibilityDescriptorV1Schema } from '../src/runtime-compatibility.js'

const digest = (character: string) => `sha256:${character.repeat(64)}`

const descriptor = {
  schemaVersion: '1.0.0',
  runtime: {
    packageName: '@mutil-skills/e2e-runtime',
    packageVersion: '0.5.2',
    nodeRange: '>=22.13.0',
    protocol: { major: 1, envelopeSchemaVersion: '1.0.0' },
  },
  state: {
    currentSnapshotSchemaVersion: '1.8.0',
    migrationSourceSchemaVersions: [
      '1.0.0', '1.1.0', '1.2.0', '1.3.0',
      '1.4.0', '1.5.0', '1.6.0', '1.7.0',
    ],
    restrictions: [{ schemaVersion: '1.0.0', condition: 'created-workflow-only' }],
  },
  artifacts: { schemaSetDigest: digest('a') },
  prd: { designSchemaVersions: ['1.0.0', '2.0.0'] },
  executor: {
    boundary: 'capability-branded',
    capabilities: [
      'target-probe', 'preflight', 'read', 'reversible-write', 'injection', 'full-playwright',
    ],
  },
  runBinding: {
    mode: 'exact-installation-digest',
    installationDigest: digest('b'),
    automaticUpgrade: false,
  },
}

describe('RuntimeCompatibilityDescriptorV1', () => {
  test('接受完整且严格的 0.5.2 兼容事实', () => {
    expect(RuntimeCompatibilityDescriptorV1Schema.parse(descriptor)).toEqual(descriptor)
  })

  test('拒绝未知字段、非摘要安装绑定和自动升级活跃 Run', () => {
    expect(RuntimeCompatibilityDescriptorV1Schema.safeParse({
      ...descriptor,
      runtime: { ...descriptor.runtime, inferredSupport: true },
    }).success).toBe(false)
    expect(RuntimeCompatibilityDescriptorV1Schema.safeParse({
      ...descriptor,
      runBinding: { ...descriptor.runBinding, installationDigest: 'latest' },
    }).success).toBe(false)
    expect(RuntimeCompatibilityDescriptorV1Schema.safeParse({
      ...descriptor,
      runBinding: { ...descriptor.runBinding, automaticUpgrade: true },
    }).success).toBe(false)
  })

  test('拒绝乱序、重复或夸大的版本和 capability 声明', () => {
    expect(RuntimeCompatibilityDescriptorV1Schema.safeParse({
      ...descriptor,
      state: {
        ...descriptor.state,
        migrationSourceSchemaVersions: ['1.7.0', '1.6.0'],
      },
    }).success).toBe(false)
    expect(RuntimeCompatibilityDescriptorV1Schema.safeParse({
      ...descriptor,
      prd: { designSchemaVersions: ['1.0.0', '2.0.0', '3.0.0'] },
    }).success).toBe(false)
    expect(RuntimeCompatibilityDescriptorV1Schema.safeParse({
      ...descriptor,
      executor: {
        ...descriptor.executor,
        capabilities: [...descriptor.executor.capabilities, 'shell'],
      },
    }).success).toBe(false)
  })
})
