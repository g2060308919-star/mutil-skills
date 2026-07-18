import { canonicalizeJson, digestText } from '@mutil-skills/e2e-contracts'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, test, vi } from 'vitest'
import { RuntimeOwnedResourceRegistry } from '../src/runtime-owned-resource-registry.js'
import { runtimeLayout } from '../src/runtime-layout.js'
import { createRuntimeOwnedResourceMarker } from '../src/write-attempt.js'
import { createRuntimeTestRoots } from './fixtures.js'

const digest = (value: string) => digestText('owned-resource-registry-test/v1', value)

describe('RuntimeOwnedResourceRegistry', () => {
  test('write owned-resource registry 拒绝 installer 独占的 install staging 类型', async () => {
    const fixture = await registryFixture()
    const operation = {
      inspect: async () => ({ status: 'absent' as const, summaryDigest: digest('absent') }),
      cleanup: async () => ({ receiptDigest: digest('cleanup') }),
    }
    const registry = await fixture.open(operation)
    const descriptor = { schemaVersion: '1.0.0', stagingPath: '/installer-owned/.staging-unowned' }

    const candidate = {
      resourceId: 'INSTALL-STAGING-1',
      kind: 'install-staging',
      ownerMarker: fixture.marker,
      descriptor,
      descriptorDigest: digestText('runtime-owned-resource-descriptor/v1', canonicalizeJson(descriptor)),
      registeredAt: '2026-07-18T00:00:00.000Z',
    } as unknown as Parameters<typeof registry.register>[0]
    await expect(registry.register(candidate))
      .rejects.toMatchObject({ code: 'E2E_RUNTIME_OWNED_RESOURCE_STATE_CORRUPT' })
    registry.close()
  })

  test('持久化 owner/descriptor，外部 inspect/cleanup 后以短事务 CAS 写 cleaned tombstone', async () => {
    const fixture = await registryFixture()
    const cleanup = vi.fn(async () => ({ receiptDigest: digest('cleanup-receipt') }))
    const registry = await fixture.open({ inspect: async () => ({ status: 'owned', summaryDigest: digest('owned') }), cleanup })
    await registry.register(recordInput(fixture.marker, 'ENDPOINT-1', 'loopback-endpoint'))
    await expect(registry.cleanupOwned(fixture.marker)).resolves.toMatchObject({ status: 'cleaned' })
    expect(cleanup).toHaveBeenCalledOnce()
    registry.close()

    const reopened = await fixture.open({ inspect: async () => ({ status: 'owned', summaryDigest: digest('owned') }), cleanup })
    await expect(reopened.cleanupOwned(fixture.marker)).resolves.toMatchObject({ status: 'absent' })
    expect(cleanup).toHaveBeenCalledOnce()
    reopened.close()
  })

  test('任一记录 owner mismatch 时保持全部资源原样且不调用 cleanup', async () => {
    const fixture = await registryFixture()
    const cleanup = vi.fn(async () => ({ receiptDigest: digest('cleanup-receipt') }))
    const registry = await fixture.open({ inspect: async (record) => ({
      status: record.resourceId === 'LOCK-2' ? 'owner-mismatch' : 'owned',
      summaryDigest: digest(`inspect:${record.resourceId}`),
    }), cleanup })
    await registry.register(recordInput(fixture.marker, 'LOCK-1', 'browser-profile-lock'))
    await registry.register(recordInput(fixture.marker, 'LOCK-2', 'browser-profile-lock'))
    await expect(registry.cleanupOwned(fixture.marker)).resolves.toMatchObject({ status: 'owner-mismatch' })
    expect(cleanup).not.toHaveBeenCalled()
    registry.close()
  })

  test('正常关闭通过精确 record revision 写 cleaned tombstone，恢复不再重复清理', async () => {
    const fixture = await registryFixture()
    const cleanup = vi.fn(async () => ({ receiptDigest: digest('must-not-clean') }))
    const registry = await fixture.open({
      inspect: async () => ({ status: 'owned', summaryDigest: digest('owned') }), cleanup,
    })
    const active = await registry.register(recordInput(
      fixture.marker, 'PROFILE-NORMAL-CLOSE', 'browser-profile-lock',
    ))
    await expect(registry.complete({
      resourceId: active.resourceId,
      ownerMarkerDigest: active.ownerMarker.markerDigest,
      expectedRevision: active.revision,
      cleanupReceiptDigest: digest('normal-close'),
    })).resolves.toMatchObject({ status: 'cleaned', revision: 2 })
    await expect(registry.cleanupOwned(fixture.marker)).resolves.toMatchObject({ status: 'absent' })
    expect(cleanup).not.toHaveBeenCalled()
    registry.close()
  })
})

async function registryFixture() {
  const roots = await createRuntimeTestRoots()
  const state = runtimeLayout(roots.home).state
  await mkdir(state, { recursive: true, mode: 0o700 })
  const statePath = join(state, 'owned-resources.sqlite')
  const marker = createRuntimeOwnedResourceMarker({ runtimeInstallationDigest: digest('installation'),
    projectIdentityDigest: digest('project'), runId: 'RUN-1', attemptId: 'ATTEMPT-1', ownerNonce: 'OWNER-1' })
  return { marker, open: async (operation: {
    inspect: (record: any) => Promise<any>; cleanup: (record: any) => Promise<any>
  }) => await RuntimeOwnedResourceRegistry.open({ statePath, testWorkspaceRoots: [roots.project],
    operations: { 'loopback-endpoint': operation, 'browser-profile-lock': operation } }) }
}

function recordInput(marker: ReturnType<typeof createRuntimeOwnedResourceMarker>, resourceId: string,
  kind: 'loopback-endpoint' | 'browser-profile-lock') {
  const descriptor = { path: `/managed/${resourceId}` }
  return { resourceId, kind, ownerMarker: marker, descriptor,
    descriptorDigest: digestText('runtime-owned-resource-descriptor/v1', JSON.stringify(descriptor)),
    registeredAt: '2026-07-17T00:00:00.000Z' }
}
