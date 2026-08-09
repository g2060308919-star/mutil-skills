import { readFile } from 'node:fs/promises'
import { describe, expect, test } from 'vitest'
import { parseRuntimeRequest } from '../src/protocol.js'
import { createRuntimeCurrent, type VerifiedRuntimeVersion } from '../src/runtime-manifest.js'
import { RuntimeStateMigrationRegistry } from '../src/runtime-state-migration.js'
import { describeRuntimeCompatibility } from '../src/runtime-compatibility.js'

const digest = (character: string) => `sha256:${character.repeat(64)}`

describe('describeRuntimeCompatibility', () => {
  test('只读投影 0.8.0 已证明的协议、状态、PRD、执行器和 Run 绑定事实', () => {
    const result = describeRuntimeCompatibility({
      artifactSchemaSetDigest: digest('a'),
      runtimeInstallationDigest: digest('b'),
    })

    expect(result).toEqual({
      schemaVersion: '1.0.0',
      runtime: {
        packageName: '@mutil-skills/e2e-runtime',
        packageVersion: '0.8.0',
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
    })
    expect(Object.keys(RuntimeStateMigrationRegistry)).toEqual(
      result.state.migrationSourceSchemaVersions,
    )
  })

  test('对格式错误的 Schema Set 或 installation binding fail closed', () => {
    for (const invalidDigest of ['latest', 'sha256:short', `sha256:${'A'.repeat(64)}`]) {
      expect(() => describeRuntimeCompatibility({
        artifactSchemaSetDigest: invalidDigest,
        runtimeInstallationDigest: digest('b'),
      })).toThrow()
      expect(() => describeRuntimeCompatibility({
        artifactSchemaSetDigest: digest('a'),
        runtimeInstallationDigest: invalidDigest,
      })).toThrow()
    }
  })

  test('每次返回独立投影，调用方修改结果不会污染后续兼容事实', () => {
    const input = { artifactSchemaSetDigest: digest('a'), runtimeInstallationDigest: digest('b') }
    const first = describeRuntimeCompatibility(input)
    first.executor.capabilities.reverse()

    expect(describeRuntimeCompatibility(input).executor.capabilities).toEqual([
      'target-probe', 'preflight', 'read', 'reversible-write', 'injection', 'full-playwright',
    ])
  })

  test('与已验证 current pointer、真实 Schema Set 指针和严格 RPC 协议语义一致', async () => {
    const schemaPointer = JSON.parse(await readFile(
      'packages/e2e-contracts/schemas/current.json', 'utf8',
    )) as { setDigest: string }
    const installation: VerifiedRuntimeVersion = {
      version: '0.8.0',
      versionRoot: '/verified/runtime/0.8.0',
      entrypoint: '/verified/runtime/0.8.0/repo-e2e.js',
      manifest: { schemaVersion: '1.0.0', files: [], installationDigest: digest('b') },
    }
    const current = createRuntimeCurrent(installation)
    const result = describeRuntimeCompatibility({
      artifactSchemaSetDigest: schemaPointer.setDigest,
      runtimeInstallationDigest: current.runtimeManifestDigest,
    })

    expect(result.artifacts.schemaSetDigest).toBe(schemaPointer.setDigest)
    expect(result.runtime.packageVersion).toBe(current.runtimeVersion)
    expect(result.runtime.protocol.major).toBe(current.protocolMajor)
    expect(result.runBinding.installationDigest).toBe(current.runtimeManifestDigest)
    expect(parseRuntimeRequest(JSON.stringify({
      schemaVersion: result.runtime.protocol.envelopeSchemaVersion,
      requestId: 'REQ-COMPATIBILITY-1',
      client: { name: 'compatibility-test', version: result.runtime.packageVersion },
      command: 'doctor',
      payload: {},
    })).command).toBe('doctor')
    expect(() => parseRuntimeRequest(JSON.stringify({
      schemaVersion: '2.0.0',
      requestId: 'REQ-COMPATIBILITY-2',
      client: { name: 'compatibility-test', version: result.runtime.packageVersion },
      command: 'doctor',
      payload: {},
    }))).toThrowError(expect.objectContaining({ code: 'E2E_RUNTIME_PROTOCOL_MAJOR_UNSUPPORTED' }))
  })
})
