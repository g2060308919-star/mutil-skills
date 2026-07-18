import { canonicalizeJson, digestText } from '@mutil-skills/e2e-contracts'
import { describe, expect, test, vi } from 'vitest'
import {
  authorizeRuntimeWriteProduction,
  createRegisteredRuntimeWriteOwnedResource,
  createRuntimeWriteOwnedResourceLifecycle,
  prepareRuntimeWriteCleanup,
  recoverRuntimeProductionWrite,
  registerRuntimeWriteOwnedResource,
  type RuntimeWriteProductionCapability,
} from '../src/runtime-write-production.js'
import { createRuntimeOwnedResourceMarker } from '../src/write-attempt.js'

const digest = (value: string): string => digestText('runtime-write-production-test/v1', value)

describe('Runtime production write capability', () => {
  test('同一不可伪造能力同时绑定 owned-resource 登记与 recovery', async () => {
    const marker = createRuntimeOwnedResourceMarker({
      runtimeInstallationDigest: digest('installation'),
      projectIdentityDigest: digest('project'),
      runId: 'RUN-1',
      attemptId: 'ATTEMPT-1',
      ownerNonce: 'OWNER-1',
    })
    const descriptor = { endpointId: 'ENDPOINT-1' }
    const register = vi.fn(async (record) => ({ ...record, revision: 1 as const, status: 'active' as const }))
    const recover = vi.fn(async () => ({
      status: 'recovered' as const,
      writeState: 'effect-unknown' as const,
      next: 'reporting',
      browserCalls: 0 as const,
    }))
    const prepareCleanup = vi.fn(async () => undefined)
    const capability = authorizeRuntimeWriteProduction({
      recovery: { recover },
      ownedResources: { register, complete: vi.fn() },
      prepareCleanup,
    })

    await expect(registerRuntimeWriteOwnedResource(capability, {
      resourceId: 'RESOURCE-1',
      kind: 'loopback-endpoint',
      ownerMarker: marker,
      descriptor,
      descriptorDigest: digestText(
        'runtime-owned-resource-descriptor/v1', canonicalizeJson(descriptor),
      ),
      registeredAt: '2026-07-18T00:00:00.000Z',
    })).resolves.toMatchObject({ resourceId: 'RESOURCE-1', status: 'active' })
    await expect(recoverRuntimeProductionWrite(capability, {
      projectIdentityDigest: digest('project'), runId: 'RUN-1', attemptId: 'ATTEMPT-1',
    })).resolves.toMatchObject({ status: 'recovered', browserCalls: 0 })
    await expect(prepareRuntimeWriteCleanup(capability, {
      projectIdentityDigest: digest('project'), runId: 'RUN-1', attemptId: 'ATTEMPT-1',
      cleanupDigest: digest('cleanup'), preparedAt: '2026-07-18T00:00:00.000Z',
    })).resolves.toBeUndefined()
    expect(register).toHaveBeenCalledTimes(1)
    expect(recover).toHaveBeenCalledTimes(1)
    expect(prepareCleanup).toHaveBeenCalledWith(expect.objectContaining({ cleanupDigest: digest('cleanup') }))
  })

  test('拒绝调用方伪造的裸 capability', async () => {
    const forged = Object.freeze({}) as RuntimeWriteProductionCapability
    await expect(recoverRuntimeProductionWrite(forged, {
      projectIdentityDigest: digest('project'), runId: 'RUN-1', attemptId: 'ATTEMPT-1',
    })).rejects.toMatchObject({ code: 'E2E_RUNTIME_WRITE_PRODUCTION_CAPABILITY_INVALID' })
  })

  test.each(['loopback-endpoint', 'browser-profile-lock'] as const)(
    '%s 必须先持久登记 owner/descriptor，之后才允许创建',
    async (kind) => {
      const order: string[] = []
      const marker = createRuntimeOwnedResourceMarker({
        runtimeInstallationDigest: digest('installation'), projectIdentityDigest: digest('project'),
        runId: 'RUN-1', attemptId: 'ATTEMPT-1', ownerNonce: 'OWNER-1',
      })
      const register = vi.fn(async (record) => {
        order.push('registered')
        return { ...record, revision: 1 as const, status: 'active' as const }
      })
      const capability = authorizeRuntimeWriteProduction({
        recovery: { recover: vi.fn() }, ownedResources: { register, complete: vi.fn() },
        prepareCleanup: vi.fn(),
      })
      const descriptor = { kind, path: `/runtime/${kind}` }
      await expect(createRegisteredRuntimeWriteOwnedResource(capability, {
        resourceId: `RESOURCE-${kind}`, kind, ownerMarker: marker, descriptor,
        descriptorDigest: digestText('runtime-owned-resource-descriptor/v1', canonicalizeJson(descriptor)),
        registeredAt: '2026-07-18T00:00:00.000Z',
      }, async (registered) => {
        expect(registered.kind).toBe(kind)
        order.push('created')
        return registered.resourceId
      })).resolves.toBe(`RESOURCE-${kind}`)
      expect(order).toEqual(['registered', 'created'])
    },
  )

  test('lifecycle resourceId 固定长度，不把最长 attemptId 拼入 registry key', async () => {
    const marker = createRuntimeOwnedResourceMarker({
      runtimeInstallationDigest: digest('installation'), projectIdentityDigest: digest('project'),
      runId: 'RUN-1', attemptId: 'A'.repeat(256), ownerNonce: 'OWNER-1',
    })
    const register = vi.fn(async (record) => ({ ...record, revision: 1, status: 'active' as const }))
    const lifecycle = createRuntimeWriteOwnedResourceLifecycle(authorizeRuntimeWriteProduction({
      recovery: { recover: vi.fn() }, ownedResources: { register, complete: vi.fn() },
      prepareCleanup: vi.fn(),
    }), marker)
    const record = await lifecycle.register('loopback-endpoint', { markerPath: '/runtime/marker' })
    expect(record.resourceId.length).toBeLessThanOrEqual(256)
    expect(record.resourceId).not.toContain(marker.attemptId)
  })
})
