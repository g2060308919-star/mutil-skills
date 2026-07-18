import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import {
  canonicalizeJson,
  digestText,
  type ReadApprovalSubject,
  type SignedReadGrant,
} from '@mutil-skills/e2e-contracts'
import {
  LocalRegressionDiscoveryAuthority,
  createTrustedCompilerControlledReadLauncher,
  executeTrustedCompilerProject,
  prepareTrustedCompilerRun,
  projectCompilerInputFromArtifacts,
  startTrustedCompilerControlledReadBridge,
  type BrowserPageAdapter,
} from '@mutil-skills/e2e-playwright-runtime'
import {
  approvedCompilerArtifacts,
  compilerArtifactVerification,
  createCompilerTestExecutionTrust,
} from '../packages/e2e-playwright-runtime/test/compiler-artifacts.fixture.js'

const projectDirectories: string[] = []

afterEach(async () => {
  await Promise.all(projectDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

describe('受控只读多 Action 回归', () => {
  test('首个业务断言失败后继续采集后续 Action，并在 Case 末尾统一失败', async () => {
    const session = await createMultiActionSession()
    const actions = [
      { actionId: 'ACTION-READ-1', target: '订单状态', expected: '待审核' },
      { actionId: 'ACTION-READ-2', target: '订单状态详情', expected: '待审核详情' },
    ]
    const launcher = createTrustedCompilerControlledReadLauncher(actions.map((action, index) => ({
      action,
      runnerInput: {
        caseId: 'CASE-READ-1',
        actionId: action.actionId,
        url: 'https://test.example.com/orders',
        expectedIdentity: { url: 'https://test.example.com/orders', title: '订单', heading: '订单列表' },
        expectedText: action.expected,
        runtime: { sandboxHealthy: true, gatewayConnected: true },
        ...readAuthorizationInput(action.actionId, index),
        gatewayAudit: { received: 1, forwarded: 1, blocked: 0, byIntent: { 'INTENT-DOCUMENT': 1 } },
        page: fakePage(index === 1, index),
      },
    })), session)
    const bridge = await startTrustedCompilerControlledReadBridge({ session, actions, launch: launcher })

    const execution = await executeTrustedCompilerProject({ session, readBridge: bridge, timeoutMs: 30_000 })
      .finally(() => bridge.close())
    expect(execution.exitCode).not.toBe(0)
    const executionOutput = `${execution.stdout}\n${execution.stderr}`
    expect(executionOutput).toContain('BIZTEST_READ_ASSERTION_FAILED:ACTION-READ-1')
    const captured = bridge.executions()
    const snapshot = bridge.snapshot()
    expect(captured.map((item) => ({ actionId: item.result.actionId, status: item.result.status }))).toEqual([
      { actionId: 'ACTION-READ-1', status: 'failed' },
      { actionId: 'ACTION-READ-2', status: 'passed' },
    ])
    expect(captured.every((item) => item.evidence.screenshot.byteLength > 0 && item.evidence.dom.byteLength > 0)).toBe(true)
    expect(snapshot).toMatchObject({
      plannedActionIds: ['ACTION-READ-1', 'ACTION-READ-2'], complete: true,
      executions: [{ result: { actionId: 'ACTION-READ-1' } }, { result: { actionId: 'ACTION-READ-2' } }],
    })
    expect(snapshot).not.toHaveProperty('halt')
  })

  test('安全阻断立即停止 Case，且不得执行或消费后续 Action', async () => {
    const session = await createMultiActionSession()
    const actions = [
      { actionId: 'ACTION-READ-1', target: '订单状态', expected: '待审核' },
      { actionId: 'ACTION-READ-2', target: '订单状态详情', expected: '待审核详情' },
    ]
    let secondActionOracleCalls = 0
    const launcher = createTrustedCompilerControlledReadLauncher(actions.map((action, index) => ({
      action,
      runnerInput: {
        caseId: 'CASE-READ-1', actionId: action.actionId, url: 'https://test.example.com/orders',
        expectedIdentity: { url: 'https://test.example.com/orders', title: '订单', heading: '订单列表' },
        expectedText: action.expected, runtime: { sandboxHealthy: true, gatewayConnected: true },
        ...readAuthorizationInput(action.actionId, index, index === 0),
        gatewayAudit: { received: 1, forwarded: 1, blocked: 0, byIntent: { 'INTENT-DOCUMENT': 1 } },
        page: fakePage(true, index, () => { if (index === 1) secondActionOracleCalls += 1 }),
      },
    })), session)
    const bridge = await startTrustedCompilerControlledReadBridge({ session, actions, launch: launcher })

    const execution = await executeTrustedCompilerProject({ session, readBridge: bridge, timeoutMs: 30_000 })
      .finally(() => bridge.close())

    expect(execution.exitCode).not.toBe(0)
    expect(`${execution.stdout}\n${execution.stderr}`)
      .toContain('BIZTEST_READ_EXECUTION_BLOCKED:safety-blocked:E2E_RUNTIME_READ_RESERVATION_FINALIZE_FAILED')
    expect(secondActionOracleCalls).toBe(0)
    expect(() => bridge.executions()).toThrow('E2E_CONTROLLED_READ_RESULTS_INCOMPLETE')
    expect(bridge.snapshot()).toMatchObject({
      plannedActionIds: ['ACTION-READ-1', 'ACTION-READ-2'],
      complete: false,
      executions: [{ result: {
        actionId: 'ACTION-READ-1', status: 'safety-blocked',
        reasonCode: 'E2E_RUNTIME_READ_RESERVATION_FINALIZE_FAILED',
      } }],
      halt: {
        status: 'safety-blocked', actionId: 'ACTION-READ-1',
        reasonCode: 'E2E_RUNTIME_READ_RESERVATION_FINALIZE_FAILED',
      },
    })
  })
})

async function createMultiActionSession() {
  const discoveryAuthority = LocalRegressionDiscoveryAuthority.create({
    issuer: 'MULTI-ACTION-DISCOVERY', keyId: 'MULTI-ACTION-DISCOVERY-KEY',
  })
  const compiled = await discoveryAuthority.compileAndAttest({
    tempParent: join(process.cwd(), '.tmp'),
    compilerInput: projectCompilerInputFromArtifacts({
      artifacts: approvedCompilerArtifacts({ additionalReadAction: true }),
      playwrightVersion: '1.61.1',
      ...compilerArtifactVerification,
    }),
  })
  projectDirectories.push(compiled.projectDir)
  return prepareTrustedCompilerRun({
    projectDir: compiled.projectDir, subject: compiled.subject, attestation: compiled.attestation,
    trust: await createCompilerTestExecutionTrust(discoveryAuthority.verifierMaterial),
    expected: {
      assetId: compiled.subject.assetId, generationId: compiled.subject.generationId,
      prdRevision: compiled.subject.prdRevision, runId: 'RUN-1',
      approvalDigest: compiled.subject.approvalDigest, executionProfile: 'trusted-read-only',
    },
    authorityTransport: 'in-process-test',
  })
}

function fakePage(containsExpectedText: boolean, index: number, onContains = () => {}): BrowserPageAdapter {
  return {
    async goto() {},
    async identity() {
      return { url: 'https://test.example.com/orders', title: '订单', headings: ['订单列表'], role: 'auditor' }
    },
    async containsText() { onContains(); return containsExpectedText },
    async screenshot() { return new Uint8Array([index + 1, index + 2, index + 3]) },
    async domSnapshot() { return `<main data-action="${index + 1}">订单列表</main>` },
  }
}

function readAuthorizationInput(actionId: string, index: number, finalizeFails = false): {
  authorization: {
    grant: SignedReadGrant
    currentSubject: ReadApprovalSubject
    authority: {
      reserveForSubject(input: { capabilityId: string; actionId: string; attemptId: string }): Promise<{
        reservationId: string; grantId: string; capabilityId: string; actionId: string
        attemptId: string; status: 'reserved'; reservedAt: string
      }>
      complete(reservationId: string, outcomeDigest: string): Promise<void>
      markUnknown(reservationId: string, observation: string): Promise<void>
    }
  }
  attemptId: string
} {
  const digest = digestText('multi-action-golden/v1', actionId)
  const currentSubject: ReadApprovalSubject = {
    schemaVersion: '2.0.0', assetId: 'PRODUCT/PRD-1', prdRevision: digest, scopeDigest: digest,
    requirementModelDigest: digest, coveragePolicyDigest: digest, universeDigest: digest,
    caseDigest: digest, actionMapDigest: digest, policyDigest: digest,
    executionContractDigest: digest, runBundleProjectionDigest: digest,
    environment: 'test', baseOrigin: 'https://test.example.com', actor: 'auditor',
    discoveryGrantId: 'GRANT-DISCOVERY-READY', preflightDigest: digest,
    actions: [
      { actionId, operation: 'local-navigation', maxUses: 1 },
      { actionId, operation: 'dom-read', maxUses: 1 },
      { actionId, operation: 'screenshot', maxUses: 1 },
    ],
  }
  const grant: SignedReadGrant = {
    grantId: `GRANT-READ-${index + 1}`, issuer: 'test-authority', keyId: 'test-key',
    proofScope: 'local-os-user', approver: { subject: 'os-user:test', roles: ['e2e-approver'] },
    subject: currentSubject,
    subjectDigest: digestText('approval-subject/v1', canonicalizeJson(currentSubject)),
    issuedAt: '2026-07-15T00:00:00.000Z', expiresAt: '2026-07-16T00:00:00.000Z',
    capabilities: currentSubject.actions.map((action, capabilityIndex) => ({
      capabilityId: `CAP-${index + 1}-${capabilityIndex + 1}`,
      nonce: `${index}${capabilityIndex}`.repeat(32), transport: 'browser-local', effect: 'read', ...action,
    })),
    revocationSequence: 0, signature: 'signature',
  }
  return {
    authorization: {
      grant,
      currentSubject,
      authority: {
        async reserveForSubject(input) {
          return {
            reservationId: `RES-${input.capabilityId}`, grantId: grant.grantId,
            capabilityId: input.capabilityId, actionId: input.actionId, attemptId: input.attemptId,
            status: 'reserved', reservedAt: '2026-07-15T00:00:00.000Z',
          }
        },
        async complete() {
          if (finalizeFails) throw new Error('authority finalize unavailable')
        },
        async markUnknown() {},
      },
    },
    attemptId: `ATTEMPT-READ-${index + 1}`,
  }
}
