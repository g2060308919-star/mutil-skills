import { describe, expect, test } from 'vitest'
import {
  createRuntimeLkgRecoveryDrillArtifact,
  createRuntimeRevocationDrillArtifact,
} from '../src/stable-activation-drills.js'
import type { RuntimeUpdateState, SignedRuntimeTarget } from '../src/runtime-update-trust.js'

const D = (character: string) => `sha256:${character.repeat(64)}`
const COMMIT = 'a'.repeat(40)
const pointer = { runtimeVersion: '0.7.0', installationDigest: D('3') }

describe('stable 更新演练证明', () => {
  test('撤销演练必须同时证明 metadata 前进、tombstone 命中和新旧 Run 阻断', () => {
    const before = state(1, pointer, pointer)
    const after = { ...state(2, null, null), revocations: [{ ...pointer,
      reasonCode: 'SECURITY-REVOKED', targetsMetadataVersion: 2,
      observedAt: '2026-08-09T00:00:00.000Z' }] }
    const artifact = createRuntimeRevocationDrillArtifact({ before, after, target: target(true),
      environmentId: 'STABLE-1', sourceCommit: COMMIT,
      observedAt: new Date('2026-08-09T00:00:00.000Z') })
    expect(artifact).toMatchObject({ passed: true, metadataAdvanced: true,
      newRunBlocked: true, existingRunBlocked: true })
  })

  test('LKG 演练证明 metadata 不回退、只恢复新 Run default、已有 Run 绑定不变', () => {
    const before = state(1, null, pointer)
    const after = state(1, pointer, pointer)
    const artifact = createRuntimeLkgRecoveryDrillArtifact({ before, after,
      environmentId: 'STABLE-1', sourceCommit: COMMIT,
      existingRunInstallationDigestBefore: D('9'), existingRunInstallationDigestAfter: D('9') })
    expect(artifact).toMatchObject({ passed: true, metadataHighwaterPreserved: true,
      lkgPromoted: true, existingRunBindingPreserved: true })
  })
})

function state(
  version: number,
  newRunDefault: RuntimeUpdateState['newRunDefault'],
  lkg: RuntimeUpdateState['lkg'],
): RuntimeUpdateState {
  return { schemaVersion: '1.1.0', highwaterWallClock: '2026-08-09T00:00:00.000Z',
    metadata: { root: role(version, '4'), timestamp: role(version, '5'),
      snapshot: role(version, '6'), targets: role(version, '7') },
    verifiedTargets: [], revocations: [], revocationOverflow: null,
    newRunDefault, lkg, audit: [] }
}
function role(version: number, character: string) {
  return { version, digest: D(character), expires: '2027-08-09T00:00:00.000Z' }
}
function target(revoked: boolean): SignedRuntimeTarget {
  return { name: 'stable/e2e-runtime-0.7.0.tgz', length: 1,
    hashes: { sha512: Buffer.alloc(64, 1).toString('hex') }, custom: {
      schemaVersion: '1.0.0', packageName: '@mutil-skills/e2e-runtime', runtimeVersion: '0.7.0',
      protocolMajor: 1, channel: 'stable', npmIntegrity: `sha512-${Buffer.alloc(64, 1).toString('base64')}`,
      registryUrl: 'https://registry.npmjs.org/stable/e2e-runtime-0.7.0.tgz', contentDigest: D('1'),
      executableDigest: D('2'), installationDigest: D('3'),
      supportedNode: [{ major: 24, minimumPatch: '24.0.0' }],
      supportedPlatforms: [{ platform: 'darwin', arch: 'arm64' }], minimumBootstrapVersion: '0.6.0',
      revoked, revocationReasonCode: revoked ? 'SECURITY-REVOKED' : null,
    } }
}
