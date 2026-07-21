import { EventEmitter } from 'node:events'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { expect, test, vi } from 'vitest'
import { RuntimeRequestEnvelopeSchema, SignedGrantSchema } from '@mutil-skills/e2e-contracts'

let lastChild: RecoveryChild | undefined

class RecoveryChild extends EventEmitter {
  pid = 4242
  connected = true
  exitCode: number | null = null
  signalCode: NodeJS.Signals | null = null
  readonly received: Array<Record<string, any>> = []
  grant: Record<string, any> | undefined
  binding: Record<string, any> | undefined

  send(message: Record<string, any>, callback?: (error: Error | null) => void): boolean {
    this.received.push(structuredClone(message))
    queueMicrotask(() => {
      callback?.(null)
      if (message.type === 'start') {
        this.emit('message', {
          type: 'ready', endpoint: 'http://127.0.0.1:43210/v1/authority-rpc',
          verifierMaterial: {
            schemaVersion: '1.0.0', issuer: 'authority-host', keyId: 'rpc-key',
            purpose: 'authority-rpc-response/v1', algorithm: 'Ed25519',
            publicKeySpkiBase64Url: Buffer.from('public-key').toString('base64url'),
            publicKeyDigest: `sha256:${'a'.repeat(64)}`,
          },
        })
      } else if (message.type === 'open-approval-session') {
        this.binding = structuredClone(message.input)
        this.emit('message', {
          type: 'session-opened', requestId: message.requestId,
          url: `http://localhost:43211/#${'b'.repeat(43)}`, sessionId: 'SESSION-CHILD-RECOVERY',
        })
        setTimeout(() => this.emit('message', {
          type: 'session-finished', sessionId: 'SESSION-CHILD-RECOVERY',
        }), 0)
      } else if (message.type === 'finalize-approval') {
        const subject = message.input.grantSubject
        const context = {
          schemaVersion: '1.0.0', subject: 'local:user', ...this.binding,
          origin: 'http://localhost:43211',
          issuedAt: '2026-07-17T00:00:00.000Z', expiresAt: '2026-07-17T00:05:00.000Z',
        }
        const action = subject.actions[0]
        this.grant = {
          grantId: 'GRANT-CHILD-RECOVERY', issuer: 'authority', keyId: 'approval-key',
          proofScope: 'local-os-user', approver: { subject: 'local:user', roles: ['e2e-approver'] },
          approvalContext: context, subject, subjectDigest: this.binding!.subjectDigest,
          issuedAt: '2026-07-17T00:00:00.000Z', expiresAt: '2026-07-17T00:01:00.000Z',
          capabilities: [{
            capabilityId: 'CAP-CHILD-RECOVERY', nonce: 'c'.repeat(64),
            transport: 'websocket', effect: 'read', actionId: action.actionId,
            origin: action.origin, path: action.path,
            maxInboundMessages: action.maxInboundMessages, maxBytes: action.maxBytes, maxUses: 1,
          }],
          revocationSequence: 0, signature: 's'.repeat(86),
        }
        // Simulates: durable Authority commit succeeded, ephemeral RPC registration failed.
        this.emit('message', {
          type: 'control-error', requestId: message.requestId,
          code: 'E2E_APPROVAL_FINALIZATION_RECOVERY_REQUIRED',
        })
      } else if (message.type === 'recover-approval') {
        this.emit('message', {
          type: 'approval-recovered', requestId: message.requestId,
          result: this.grant === undefined ? { found: false } : {
            found: true, grant: this.grant, approvalBinding: this.binding,
            sessionId: 'SESSION-CHILD-RECOVERY',
          },
        })
      } else if (message.type === 'ack-finalization') {
        this.emit('message', {
          type: 'finalization-acknowledged', requestId: message.requestId,
          result: { acknowledged: true },
        })
      } else if (message.type === 'shutdown') {
        this.emit('message', { type: 'shutdown-result', requestId: message.requestId, ok: true })
        this.connected = false
        this.exitCode = 0
        this.emit('disconnect')
        this.emit('exit', 0, null)
      }
    })
    return true
  }

  kill(): boolean { return true }
}

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return {
    ...actual,
    fork: vi.fn(() => (lastChild = new RecoveryChild())),
    spawn: vi.fn(() => (lastChild = new RecoveryChild())),
  }
})

import { startAuthorityExecutionRpcHostProcess } from '@mutil-skills/e2e-authority'
import { RuntimeAuthorityHost, computeRuntimeApprovalSubjectDigest } from '../src/authority-host.js'
import { E2ERuntimeHost } from '../src/runtime-host.js'
import { RuntimeRunStore, type RuntimeRunSnapshot } from '../src/run-store.js'
import { resolveProjectIdentity } from '../src/project-identity.js'
import { createRuntimeTestRoots } from './fixtures.js'

const installationDigest = `sha256:${'a'.repeat(64)}`

test('child commit-after-registration failure stays pending and Runtime recovers without a second WebAuthn session', async () => {
  const roots = await createRuntimeTestRoots()
  const runStore = await RuntimeRunStore.open({ homeDir: roots.home, projectRoot: roots.project })
  const stateEncryptionKey = Buffer.alloc(32, 7)
  let processHandle: Awaited<ReturnType<typeof startAuthorityExecutionRpcHostProcess>> | undefined
  try {
    await mkdir(`${roots.project}/.biztest`, { recursive: true })
    await writeFile(`${roots.project}/.biztest/project.json`, JSON.stringify({
      schemaVersion: '1.0.0', projectId: 'PROJECT-1',
    }))
    const identity = await resolveProjectIdentity(roots.project)
    const snapshot: RuntimeRunSnapshot = {
      schemaVersion: '1.1.0', runId: 'RUN-1', assetId: 'ASSET-1',
      projectIdentityDigest: identity.digest, runtimeInstallationDigest: installationDigest,
      workflow: {
        current: 'awaiting-execution-approval', sequence: 8,
        eventChainDigest: `sha256:${'8'.repeat(64)}`,
      },
      artifactDigests: { 'prd-source': `sha256:${'3'.repeat(64)}`, scope: `sha256:${'4'.repeat(64)}` },
      frozenArtifacts: {}, trustedExecutionFacts: {},
      requestResponses: {}, createdAt: '2026-07-16T00:00:00.000Z', updatedAt: '2026-07-16T00:00:00.000Z',
    }
    const seedDigest = `sha256:${'6'.repeat(64)}`
    await runStore.beginRequest('SEED-CHILD-RECOVERY', seedDigest)
    const seedLock = await runStore.acquireRunLock(identity.digest, snapshot.runId)
    try { await runStore.createRunOutcome(snapshot, 'SEED-CHILD-RECOVERY', seedDigest, {}, seedLock) }
    finally { await seedLock.close() }
    const grantSubject = {
      schemaVersion: '1.0.0' as const, assetId: snapshot.assetId,
      prdRevision: snapshot.artifactDigests['prd-source']!, executionDigest: `sha256:${'5'.repeat(64)}`,
      environment: 'test' as const, baseOrigin: 'https://test.example.com',
      actions: [{
        actionId: 'ACTION-WS-1', origin: 'https://test.example.com', path: '/events',
        maxInboundMessages: 1, maxBytes: 1024,
      }],
    }
    expect(computeRuntimeApprovalSubjectDigest(snapshot, 'execution', grantSubject)).toMatch(/^sha256:/)
    processHandle = await startAuthorityExecutionRpcHostProcess({
      rpc: { issuer: 'authority-host', keyId: 'rpc-key', clientId: 'runner' },
      approval: {
        issuer: 'authority', keyId: 'approval-key', statePath: 'approval.sqlite',
        stateEncryptionKey, testWorkspaceRoots: [process.cwd()],
      },
      lease: { statePath: 'lease.sqlite', testWorkspaceRoots: [process.cwd()] },
      clock: { kind: 'fixed-test-only', now: '2026-07-17T00:00:00.000Z' },
    })
    const authority = new RuntimeAuthorityHost({ processHandle, installationDigest })
    const host = new E2ERuntimeHost({
      installation: {
        version: '0.0.0', protocolMajor: 1, versionRoot: '/runtime', entrypoint: '/runtime/repo-e2e.js',
        installationDigest, sourceRepositoryIndependent: true,
      },
      doctor: async () => { throw new Error('not used') }, runStore,
      now: () => new Date('2026-07-17T00:00:00.000Z'),
      authorityHostFactory: async () => authority,
      presentUserPresenceUrl: async () => undefined,
    })
    const request = RuntimeRequestEnvelopeSchema.parse({
      schemaVersion: '1.0.0', requestId: 'APPROVE-CHILD-RECOVERY',
      client: { name: 'test', version: '1.0.0' }, command: 'open-approval', projectRoot: roots.project,
      payload: { runId: snapshot.runId, approvalType: 'execution', grantSubject },
    })

    expect(await host.handle(request, JSON.stringify(request))).toMatchObject({
      ok: false, error: { code: 'E2E_APPROVAL_FINALIZATION_RECOVERY_REQUIRED' },
    })
    const parsedGrant = SignedGrantSchema.safeParse(lastChild!.grant)
    expect(parsedGrant.success, parsedGrant.success ? '' : JSON.stringify(parsedGrant.error.issues)).toBe(true)
    const recoveredResponse = await host.handle(request, JSON.stringify(request))
    expect(recoveredResponse, JSON.stringify(recoveredResponse)).toMatchObject({
      ok: true, result: { signedGrant: { grantId: 'GRANT-CHILD-RECOVERY' } },
    })
    expect(lastChild!.received.filter((message) => message.type === 'open-approval-session')).toHaveLength(1)
    expect(lastChild!.received.filter((message) => message.type === 'finalize-approval')).toHaveLength(1)
    expect(lastChild!.received.filter((message) => message.type === 'recover-approval')).toHaveLength(2)
  } finally {
    await processHandle?.close().catch(() => undefined)
    stateEncryptionKey.fill(0)
    await runStore.close()
    await rm(roots.root, { recursive: true, force: true })
  }
})
