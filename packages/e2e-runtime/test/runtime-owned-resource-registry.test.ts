import { digestText } from '@mutil-skills/e2e-contracts'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, test, vi } from 'vitest'
import { RuntimeOwnedResourceRegistry } from '../src/runtime-owned-resource-registry.js'
import { runtimeLayout } from '../src/runtime-layout.js'
import { createRuntimeOwnedResourceMarker } from '../src/write-attempt.js'
import { createRuntimeTestRoots } from './fixtures.js'

const digest = (value: string) => digestText('owned-resource-registry-test/v1', value)

describe('RuntimeOwnedResourceRegistry', () => {
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
    operations: { 'loopback-endpoint': operation, 'browser-profile-lock': operation, 'install-staging': operation } }) }
}

function recordInput(marker: ReturnType<typeof createRuntimeOwnedResourceMarker>, resourceId: string,
  kind: 'loopback-endpoint' | 'browser-profile-lock' | 'install-staging') {
  const descriptor = { path: `/managed/${resourceId}` }
  return { resourceId, kind, ownerMarker: marker, descriptor,
    descriptorDigest: digestText('runtime-owned-resource-descriptor/v1', JSON.stringify(descriptor)),
    registeredAt: '2026-07-17T00:00:00.000Z' }
}
