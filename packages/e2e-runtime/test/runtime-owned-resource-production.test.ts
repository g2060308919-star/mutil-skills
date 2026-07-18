import { canonicalizeJson, digestText } from '@mutil-skills/e2e-contracts'
import { createServer } from 'node:http'
import { access, lstat, mkdir, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { RuntimeOwnedResourceRegistry, type RuntimeOwnedResourceRecord } from '../src/runtime-owned-resource-registry.js'
import { createRuntimeOwnedResourceOperations,
  createRuntimeOwnedResourceOperationsWithTestControl } from '../src/runtime-write-production-wiring.js'
import { createRuntimeOwnedResourceMarker } from '../src/write-attempt.js'
import { canBindLoopback, createRuntimeTestRoots, listenOnLoopback } from './fixtures.js'

const digest = (value: string) => digestText('owned-resource-production-test/v1', value)
const loopbackAvailable = await canBindLoopback()

describe('production owned-resource recovery adapters', () => {
  test('Browser profile 仅在 supervisor 明确死亡且 parent/profile inode 固定时原子隔离清理', async () => {
    const roots = await createRuntimeTestRoots()
    const suppliedState = join(roots.home, '.mutil-skills', 'e2e', 'state')
    await mkdir(suppliedState, { recursive: true, mode: 0o700 })
    const state = await realpath(suppliedState)
    const marker = ownerMarker('RUN-BROWSER-CRASH')
    const profileDir = join(state, marker.runId, 'browser', 'profile-crashed')
    await mkdir(profileDir, { recursive: true, mode: 0o700 })
    const profileParent = await realpath(join(state, marker.runId, 'browser'))
    const [parentIdentity, profileIdentity] = await Promise.all([lstat(profileParent), lstat(profileDir)])
    const descriptor = { schemaVersion: '1.0.0', profileDir, markerPath: join(profileDir, '.owner.json'),
      profileParent: { canonicalPath: profileParent, device: String(parentIdentity.dev), inode: String(parentIdentity.ino) } }
    const input = recordInput(marker, 'browser-profile-lock', descriptor)
    await writeFile(descriptor.markerPath, `${canonicalizeJson({
      schemaVersion: '1.0.0', kind: 'browser-profile-lock', ownerMarker: marker,
      descriptorDigest: input.descriptorDigest,
      phase: 'supervising',
      profileParent: descriptor.profileParent,
      profile: { device: String(profileIdentity.dev), inode: String(profileIdentity.ino) },
      ownerProcess: { role: 'supervisor', pid: 2_147_483_647, startIdentity: 'dead:100' },
    })}\n`, { mode: 0o600 })
    const registry = await RuntimeOwnedResourceRegistry.open({
      statePath: join(state, 'owned-resources.sqlite'), testWorkspaceRoots: [roots.project],
      operations: createRuntimeOwnedResourceOperationsWithTestControl(state, {
        inspectOwnerProcess: async () => ({ status: 'dead' }),
      }),
    })
    await registry.register(input)

    await expect(registry.cleanupOwned(marker)).resolves.toMatchObject({ status: 'cleaned' })
    await expect(access(profileDir)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(registry.cleanupOwned(marker)).resolves.toMatchObject({ status: 'absent' })
    registry.close()
  })

  test.each([
    { label: '活 supervisor', startIdentity: 'same:100' },
    { label: 'PID 复用', startIdentity: 'reused:999' },
  ])('Browser profile $label 时 fail closed', async ({ startIdentity }) => {
    const fixture = await browserProfileFixture()
    const operations = createRuntimeOwnedResourceOperationsWithTestControl(fixture.state, {
      inspectOwnerProcess: async () => ({ status: 'alive', startIdentity }),
    })['browser-profile-lock']
    await expect(operations.inspect(fixture.record)).resolves.toMatchObject({ status: 'owner-mismatch' })
    await expect(access(fixture.profileDir)).resolves.toBeUndefined()
  })

  test('Browser profile parent inode/path 被替换时 fail closed', async () => {
    const fixture = await browserProfileFixture()
    const movedParent = `${fixture.profileParent}-moved`
    await rename(fixture.profileParent, movedParent)
    await mkdir(fixture.profileParent, { mode: 0o700 })
    const operations = createRuntimeOwnedResourceOperationsWithTestControl(fixture.state, {
      inspectOwnerProcess: async () => ({ status: 'dead' }),
    })['browser-profile-lock']
    await expect(operations.inspect(fixture.record)).resolves.toMatchObject({ status: 'owner-mismatch' })
    await expect(access(join(movedParent, 'profile-crashed'))).resolves.toBeUndefined()
  })

  test.skipIf(!loopbackAvailable)(
    'Gateway marker 的 PID 仍活跃时阻断；dead PID 且端口关闭后才允许清理',
    async () => {
      const roots = await createRuntimeTestRoots()
      const suppliedState = join(roots.home, '.mutil-skills', 'e2e', 'state')
      await mkdir(suppliedState, { recursive: true, mode: 0o700 })
      const state = await realpath(suppliedState)
      const marker = ownerMarker('RUN-GATEWAY-CRASH')
      const markerPath = join(state, marker.runId, 'gateway',
        `session-${marker.markerDigest.slice(7, 31)}.owner.json`)
      const descriptor = { schemaVersion: '1.0.0', markerPath, sessionNonce: 'a'.repeat(64) }
      const record = activeRecord(recordInput(marker, 'loopback-endpoint', descriptor))
      await mkdir(join(state, marker.runId, 'gateway'), { recursive: true, mode: 0o700 })
      const server = createServer()
      await listenOnLoopback(server)
      const address = server.address()
      if (address === null || typeof address === 'string') throw new Error('loopback address unavailable')
      const endpoint = `http://127.0.0.1:${address.port}`
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
      const operations = createRuntimeOwnedResourceOperations(state)['loopback-endpoint']
      const writeMarker = async (pid: number) => await writeFile(markerPath, `${canonicalizeJson({
        schemaVersion: '1.0.0', kind: 'loopback-endpoint', phase: 'listening',
        ownerMarker: marker, descriptorDigest: record.descriptorDigest,
        sessionNonce: descriptor.sessionNonce, pid, endpoint,
      })}\n`, { mode: 0o600 })

      await writeMarker(process.pid)
      await expect(operations.inspect(record)).resolves.toMatchObject({ status: 'owner-mismatch' })
      await writeMarker(2_147_483_647)
      await expect(operations.inspect(record)).resolves.toMatchObject({ status: 'owned' })
      await expect(operations.cleanup(record)).resolves.toMatchObject({ receiptDigest: expect.stringMatching(/^sha256:/) })
      await expect(access(markerPath)).rejects.toMatchObject({ code: 'ENOENT' })
    },
  )
})

async function browserProfileFixture() {
  const roots = await createRuntimeTestRoots()
  const stateCandidate = join(roots.home, '.mutil-skills', 'e2e', 'state')
  await mkdir(stateCandidate, { recursive: true, mode: 0o700 })
  const state = await realpath(stateCandidate)
  const marker = ownerMarker('RUN-BROWSER-SUPERVISOR')
  const profileParent = join(state, marker.runId, 'browser')
  const profileDir = join(profileParent, 'profile-crashed')
  await mkdir(profileDir, { recursive: true, mode: 0o700 })
  const [parentIdentity, profileIdentity] = await Promise.all([lstat(profileParent), lstat(profileDir)])
  const descriptor = { schemaVersion: '1.0.0', profileDir, markerPath: join(profileDir, '.owner.json'),
    profileParent: { canonicalPath: await realpath(profileParent), device: String(parentIdentity.dev), inode: String(parentIdentity.ino) } }
  const input = recordInput(marker, 'browser-profile-lock', descriptor)
  await writeFile(descriptor.markerPath, `${canonicalizeJson({
    schemaVersion: '1.0.0', kind: 'browser-profile-lock', ownerMarker: marker,
    descriptorDigest: input.descriptorDigest, phase: 'supervising',
    profileParent: descriptor.profileParent,
    profile: { device: String(profileIdentity.dev), inode: String(profileIdentity.ino) },
    ownerProcess: { role: 'supervisor', pid: process.pid, startIdentity: 'same:100' },
  })}\n`, { mode: 0o600 })
  return { roots, state, marker, profileParent, profileDir, record: activeRecord(input) }
}

function ownerMarker(runId: string) {
  return createRuntimeOwnedResourceMarker({
    runtimeInstallationDigest: digest('runtime'), projectIdentityDigest: digest('project'),
    runId, attemptId: 'ATTEMPT-1', ownerNonce: 'OWNER-1',
  })
}

function recordInput(
  marker: ReturnType<typeof ownerMarker>,
  kind: RuntimeOwnedResourceRecord['kind'],
  descriptor: unknown,
) {
  return {
    resourceId: `${kind}-RESOURCE`, kind, ownerMarker: marker, descriptor,
    descriptorDigest: digestText('runtime-owned-resource-descriptor/v1', canonicalizeJson(descriptor)),
    registeredAt: '2026-07-18T00:00:00.000Z',
  }
}

function activeRecord(
  input: ReturnType<typeof recordInput>,
): RuntimeOwnedResourceRecord {
  return { ...input, revision: 1, status: 'active' }
}
