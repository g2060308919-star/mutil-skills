import { describe, expect, test } from 'vitest'
import {
  runBrowserPreflight, runReadOnlyCase, type BrowserPageAdapter, type DiscoveryAuthorityClient,
} from '../src/index.js'
import { canonicalizeJson, digestBytes, digestCanonicalGrantApprovalSubject, digestText,
  E2EError } from '@mutil-skills/e2e-contracts'
import type {
  DiscoveryApprovalSubject, ReadApprovalSubject, SignedDiscoveryGrant, SignedReadGrant,
} from '@mutil-skills/e2e-contracts'

function fakePage(): BrowserPageAdapter & { navigations: string[] } {
  const navigations: string[] = []
  return {
    navigations,
    async goto(url) { navigations.push(url) },
    async identity() {
      return { url: 'https://test.example.com/orders', title: '订单', headings: ['订单列表'], role: 'auditor' }
    },
    async containsText(text) { return text === '待审核' },
    async screenshot() { return new Uint8Array([1, 2, 3]) },
    async domSnapshot() { return '<main><h1>订单列表</h1><span>待审核</span></main>' },
  }
}

describe('runReadOnlyCase', () => {
  test('DiscoveryGrant 绑定的 actor/URL/页面身份全部匹配后才产生 ready preflight', async () => {
    const page = fakePage()
    page.identity = async () => ({
      url: 'https://test.example.com/orders', title: '订单', headings: ['订单列表'],
      role: 'auditor', ariaSignals: ['main:订单列表'],
    })
    const authorization = discoveryAuthorization()
    const result = await runBrowserPreflight({
      authorization, runtime: { sandboxHealthy: true, gatewayConnected: true },
      gatewayAudit: { received: 1, forwarded: 1, blocked: 0, byIntent: { 'INTENT-DOCUMENT': 1 } }, page,
      attemptId: 'ATTEMPT-PREFLIGHT-1', actionId: 'ACTION-PREFLIGHT',
    })

    expect(result).toMatchObject({
      status: 'ready', observedIdentity: { role: 'auditor' }, reservationId: 'RESERVATION-PREFLIGHT-1',
      preflightDigest: expect.stringMatching(/^sha256:/),
    })
    expect(authorization.completed).toHaveLength(1)
  })

  test('Discovery preflight 在角色不符时 input-blocked，且不需要 Execution Grant', async () => {
    const page = fakePage()
    page.identity = async () => ({
      url: 'https://test.example.com/orders', title: '订单', headings: ['订单列表'],
      role: 'ordinary-user', ariaSignals: ['main:订单列表'],
    })
    const authorization = discoveryAuthorization()
    const result = await runBrowserPreflight({
      authorization, runtime: { sandboxHealthy: true, gatewayConnected: true },
      gatewayAudit: { received: 1, forwarded: 1, blocked: 0, byIntent: { 'INTENT-DOCUMENT': 1 } }, page,
      attemptId: 'ATTEMPT-PREFLIGHT-ROLE', actionId: 'ACTION-PREFLIGHT',
    })

    expect(result).toMatchObject({ status: 'input-blocked', reasonCode: 'E2E_RUNTIME_ROLE_MISMATCH' })
    expect(result).not.toHaveProperty('executionGrant')
  })

  test('fails closed before navigation when the controlled runtime is not healthy', async () => {
    const page = fakePage()
    const result = await runReadOnlyCase({
      caseId: 'CASE-READ-1',
      actionId: 'ACTION-READ-1',
      url: 'https://test.example.com/orders',
      expectedIdentity: { title: '订单', heading: '订单列表' },
      expectedText: '待审核',
      runtime: { sandboxHealthy: false, gatewayConnected: true },
      ...readAuthorizationInput(),
      gatewayAudit: { received: 0, forwarded: 0, blocked: 0, byIntent: {} },
      page,
    })

    expect(result).toMatchObject({ status: 'safety-blocked', reasonCode: 'E2E_RUNTIME_SANDBOX_REQUIRED' })
    expect(page.navigations).toEqual([])
  })

  test('Runtime 必须用当前 ReadApprovalSubject 向 Authority 保留精确 capability，不能信任布尔授权', async () => {
    const page = fakePage()
    let reserveCalls = 0
    const result = await runReadOnlyCase({
      caseId: 'CASE-READ-1', actionId: 'ACTION-READ-1', url: 'https://test.example.com/orders',
      expectedIdentity: { title: '订单', heading: '订单列表' }, expectedText: '待审核',
      runtime: { sandboxHealthy: true, gatewayConnected: true },
      authorization: {
        grant: { capabilities: [
          { capabilityId: 'CAP-NAV', actionId: 'ACTION-READ-1', operation: 'local-navigation' },
          { capabilityId: 'CAP-DOM', actionId: 'ACTION-READ-1', operation: 'dom-read' },
          { capabilityId: 'CAP-SCREENSHOT', actionId: 'ACTION-READ-1', operation: 'screenshot' },
        ] },
        currentSubject: { actor: 'auditor' },
        authority: {
          async reserveForSubject() {
            reserveCalls += 1
            throw new E2EError({
              code: 'E2E_APPROVAL_SUBJECT_MISMATCH', category: 'decision',
              message: 'subject mismatch', retryable: false,
            })
          },
          async complete() {},
          async markUnknown() {},
        },
      },
      attemptId: 'ATTEMPT-READ-DENIED',
      gatewayAudit: { received: 1, forwarded: 1, blocked: 0, byIntent: {} }, page,
    } as never)

    expect(result).toMatchObject({ status: 'safety-blocked', reasonCode: 'E2E_APPROVAL_SUBJECT_MISMATCH' })
    expect(reserveCalls).toBe(1)
    expect(page.navigations).toEqual([])
  })

  test('后续 capability 保留失败时补偿完成此前 reservation，且不开始浏览器动作', async () => {
    const page = fakePage()
    const authorized = readAuthorizationInput()
    let reserveCalls = 0
    const completed: Array<{ reservationId: string; outcomeDigest: string }> = []
    authorized.authorization.authority = {
      async reserveForSubject(input) {
        reserveCalls += 1
        if (reserveCalls === 2) throw new E2EError({
          code: 'E2E_APPROVAL_CAPABILITY_EXHAUSTED', category: 'decision',
          message: 'capability exhausted', retryable: false,
        })
        return {
          reservationId: `RES-${input.capabilityId}`, grantId: authorized.authorization.grant.grantId,
          capabilityId: input.capabilityId, actionId: input.actionId, attemptId: input.attemptId,
          status: 'reserved' as const, reservedAt: '2026-07-12T00:00:00.000Z',
        }
      },
      async complete(reservationId, outcomeDigest) { completed.push({ reservationId, outcomeDigest }) },
      async markUnknown() {},
    }
    const result = await runReadOnlyCase({
      caseId: 'CASE-READ-1', actionId: 'ACTION-READ-1', url: 'https://test.example.com/orders',
      expectedIdentity: { title: '订单', heading: '订单列表' }, expectedText: '待审核',
      runtime: { sandboxHealthy: true, gatewayConnected: true }, ...authorized,
      gatewayAudit: { received: 0, forwarded: 0, blocked: 0, byIntent: {} }, page,
    })

    expect(result).toMatchObject({
      status: 'safety-blocked', reasonCode: 'E2E_APPROVAL_CAPABILITY_EXHAUSTED',
    })
    expect(completed).toEqual([{
      reservationId: 'RES-CAP-READ-1', outcomeDigest: expect.stringMatching(/^sha256:/),
    }])
    expect(page.navigations).toEqual([])
  })

  test('部分 reservation 补偿失败时升级为专用安全阻塞', async () => {
    const page = fakePage()
    const authorized = readAuthorizationInput()
    let reserveCalls = 0
    authorized.authorization.authority = {
      async reserveForSubject(input) {
        reserveCalls += 1
        if (reserveCalls === 2) throw new Error('reserve failed')
        return {
          reservationId: `RES-${input.capabilityId}`, grantId: authorized.authorization.grant.grantId,
          capabilityId: input.capabilityId, actionId: input.actionId, attemptId: input.attemptId,
          status: 'reserved' as const, reservedAt: '2026-07-12T00:00:00.000Z',
        }
      },
      async complete() { throw new Error('compensation failed') },
      async markUnknown() {},
    }
    const result = await runReadOnlyCase({
      caseId: 'CASE-READ-1', actionId: 'ACTION-READ-1', url: 'https://test.example.com/orders',
      expectedIdentity: { title: '订单', heading: '订单列表' }, expectedText: '待审核',
      runtime: { sandboxHealthy: true, gatewayConnected: true }, ...authorized,
      gatewayAudit: { received: 0, forwarded: 0, blocked: 0, byIntent: {} }, page,
    })

    expect(result).toMatchObject({
      status: 'safety-blocked', reasonCode: 'E2E_RUNTIME_READ_RESERVATION_COMPENSATION_FAILED',
      reservationIds: ['RES-CAP-READ-1'], outcomeDigest: expect.stringMatching(/^sha256:/),
    })
    expect(page.navigations).toEqual([])
  })

  test('complete 中途失败时把失败项及剩余项全部标为 unknown，并保留完整 reservationIds', async () => {
    const page = fakePage()
    const authorized = readAuthorizationInput()
    let completeCalls = 0
    const unknown: string[] = []
    authorized.authorization.authority = {
      async reserveForSubject(input) {
        return {
          reservationId: `RES-${input.capabilityId}`, grantId: authorized.authorization.grant.grantId,
          capabilityId: input.capabilityId, actionId: input.actionId, attemptId: input.attemptId,
          status: 'reserved' as const, reservedAt: '2026-07-12T00:00:00.000Z',
        }
      },
      async complete() {
        completeCalls += 1
        if (completeCalls === 2) throw new Error('complete failed')
      },
      async markUnknown(reservationId) { unknown.push(reservationId) },
    }
    const result = await runReadOnlyCase({
      caseId: 'CASE-READ-1', actionId: 'ACTION-READ-1', url: 'https://test.example.com/orders',
      expectedIdentity: { title: '订单', heading: '订单列表' }, expectedText: '待审核',
      runtime: { sandboxHealthy: true, gatewayConnected: true }, ...authorized,
      gatewayAudit: { received: 1, forwarded: 1, blocked: 0, byIntent: {} }, page,
    })

    expect(result).toMatchObject({
      status: 'safety-blocked', reasonCode: 'E2E_RUNTIME_READ_RESERVATION_FINALIZE_FAILED',
      reservationIds: ['RES-CAP-READ-1', 'RES-CAP-READ-2', 'RES-CAP-READ-3'],
      outcomeDigest: expect.stringMatching(/^sha256:/),
    })
    expect(unknown).toEqual(['RES-CAP-READ-2', 'RES-CAP-READ-3'])
  })

  test('records page identity, actual result, and minimum evidence for a passing case', async () => {
    const page = fakePage()
    const result = await runReadOnlyCase({
      caseId: 'CASE-READ-1',
      actionId: 'ACTION-READ-1',
      url: 'https://test.example.com/orders',
      expectedIdentity: { title: '订单', heading: '订单列表' },
      expectedText: '待审核',
      runtime: { sandboxHealthy: true, gatewayConnected: true },
      ...readAuthorizationInput(),
      gatewayAudit: { received: 1, forwarded: 1, blocked: 0, byIntent: { 'INTENT-DOCUMENT': 1 } },
      page,
    })

    expect(result).toMatchObject({
      status: 'passed',
      actual: ['页面包含文本：待审核'],
      observedIdentity: { title: '订单', headings: ['订单列表'] },
      evidence: [
        { kind: 'screenshot', byteLength: 3,
          digest: digestBytes('runtime-evidence/screenshot/v1', new Uint8Array([1, 2, 3])) },
        { kind: 'dom', byteLength: expect.any(Number), digest: expect.stringMatching(/^sha256:/) },
        { kind: 'gateway-audit', byteLength: expect.any(Number), digest: expect.stringMatching(/^sha256:/) },
      ],
    })
    expect(digestBytes('runtime-evidence/screenshot/v1', new Uint8Array([3, 2, 1])))
      .not.toBe(result.evidence[0]?.digest)
  })

  test('classifies a wrong page before evaluating the business assertion', async () => {
    const page = fakePage()
    page.identity = async () => ({ url: 'https://test.example.com/login', title: '登录', headings: ['登录'] })

    const result = await runReadOnlyCase({
      caseId: 'CASE-READ-1',
      actionId: 'ACTION-READ-1',
      url: 'https://test.example.com/orders',
      expectedIdentity: { title: '订单', heading: '订单列表' },
      expectedText: '待审核',
      runtime: { sandboxHealthy: true, gatewayConnected: true },
      ...readAuthorizationInput(),
      gatewayAudit: { received: 1, forwarded: 1, blocked: 0, byIntent: {} },
      page,
    })

    expect(result).toMatchObject({ status: 'environment-blocked', reasonCode: 'E2E_RUNTIME_PAGE_MISMATCH' })
  })

  test('标题和 heading 相同时仍拒绝错误 URL，且不执行业务 Oracle', async () => {
    const page = fakePage()
    let oracleCalls = 0
    page.identity = async () => ({ url: 'https://test.example.com/other', title: '订单', headings: ['订单列表'] })
    page.containsText = async () => { oracleCalls += 1; return true }

    const result = await runReadOnlyCase({
      caseId: 'CASE-READ-1', actionId: 'ACTION-READ-1', url: 'https://test.example.com/orders',
      expectedIdentity: { url: 'https://test.example.com/orders', title: '订单', heading: '订单列表' },
      expectedText: '待审核', runtime: { sandboxHealthy: true, gatewayConnected: true },
      ...readAuthorizationInput(),
      gatewayAudit: { received: 1, forwarded: 1, blocked: 0, byIntent: {} }, page,
    })

    expect(result).toMatchObject({ status: 'environment-blocked', reasonCode: 'E2E_RUNTIME_PAGE_URL_MISMATCH' })
    expect(oracleCalls).toBe(0)
  })

  test('角色错误为 input-blocked，不冒充业务失败且不执行 Oracle', async () => {
    const page = fakePage()
    let oracleCalls = 0
    page.identity = async () => ({
      url: 'https://test.example.com/orders', title: '订单', headings: ['订单列表'], role: 'ordinary-user',
    })
    page.containsText = async () => { oracleCalls += 1; return false }

    const result = await runReadOnlyCase({
      caseId: 'CASE-AUDITOR-1', actionId: 'ACTION-AUDITOR-READ', url: 'https://test.example.com/orders',
      expectedIdentity: { title: '订单', heading: '订单列表', role: 'auditor' },
      expectedText: '待审核', runtime: { sandboxHealthy: true, gatewayConnected: true },
      ...readAuthorizationInput('ACTION-AUDITOR-READ'),
      gatewayAudit: { received: 1, forwarded: 1, blocked: 0, byIntent: {} }, page,
    })

    expect(result).toMatchObject({ status: 'input-blocked', reasonCode: 'E2E_RUNTIME_ROLE_MISMATCH' })
    expect(result.status).not.toBe('failed')
    expect(oracleCalls).toBe(0)
  })
})

function readAuthorizationInput(actionId = 'ACTION-READ-1'): {
  authorization: {
    grant: SignedReadGrant
    currentSubject: ReadApprovalSubject
    authority: {
      reserveForSubject(input: {
        capabilityId: string; actionId: string; attemptId: string
      }): Promise<{
        reservationId: string; grantId: string; capabilityId: string; actionId: string
        attemptId: string; status: 'reserved'; reservedAt: string
      }>
      complete(reservationId: string, outcomeDigest: string): Promise<void>
      markUnknown(reservationId: string, observation: string): Promise<void>
    }
  }
  attemptId: string
} {
  const digest = digestText('test/v1', 'read-authorization')
  const currentSubject: ReadApprovalSubject = {
    schemaVersion: '2.1.0', assetId: 'PRODUCT-PRD-1', prdRevision: digest, scopeDigest: digest,
    requirementModelDigest: digest, coveragePolicyDigest: digest, universeDigest: digest,
    caseDigest: digest, actionMapDigest: digest, policyDigest: digest,
    executionContractDigest: digest, runBundleProjectionDigest: digest,
    environment: 'test', baseOrigin: 'https://test.example.com', actor: 'auditor',
    discoveryGrantId: 'GRANT-DISCOVERY-READY', preflightDigest: digest,
    requests: [],
    actions: [
      { actionId, operation: 'local-navigation', maxUses: 1, requestIds: [] },
      { actionId, operation: 'dom-read', maxUses: 1, requestIds: [] },
      { actionId, operation: 'screenshot', maxUses: 1, requestIds: [] },
    ],
  }
  const grant: SignedReadGrant = {
    grantId: 'GRANT-READ-1', issuer: 'test-authority', keyId: 'test-key', proofScope: 'local-os-user',
    approver: { subject: 'os-user:test', roles: ['e2e-approver'] }, subject: currentSubject,
    subjectDigest: digestCanonicalGrantApprovalSubject('execution', currentSubject),
    approvalContext: { schemaVersion: '1.0.0', subject: 'os-user:test', runId: 'RUN-1',
      approvalType: 'execution', subjectDigest: digestCanonicalGrantApprovalSubject('execution', currentSubject),
      installationDigest: digest, origin: 'http://127.0.0.1:43210',
      issuedAt: '2026-07-12T00:00:00.000Z', expiresAt: '2026-07-12T01:00:00.000Z' },
    issuedAt: '2026-07-12T00:00:00.000Z', expiresAt: '2026-07-12T01:00:00.000Z',
    capabilities: currentSubject.actions.map((action, index) => {
      if (action.operation === 'http-request') throw new Error('测试夹具只构造 browser-local capability')
      return {
        capabilityId: `CAP-READ-${index + 1}`, nonce: `${index}`.repeat(64), transport: 'browser-local' as const,
        effect: 'read' as const, actionId: action.actionId, operation: action.operation, maxUses: action.maxUses,
      }
    }),
    revocationSequence: 0, signature: 'signature',
  }
  return {
    authorization: {
      grant, currentSubject,
      authority: {
        async reserveForSubject(input) {
          return {
            reservationId: `RES-${input.capabilityId}`, grantId: grant.grantId,
            capabilityId: input.capabilityId, actionId: input.actionId, attemptId: input.attemptId,
            status: 'reserved', reservedAt: '2026-07-12T00:00:00.000Z',
          }
        },
        async complete() {},
        async markUnknown() {},
      },
    },
    attemptId: 'ATTEMPT-READ-1',
  }
}

function discoveryAuthorization(): {
  grant: SignedDiscoveryGrant
  currentSubject: DiscoveryApprovalSubject
  authority: DiscoveryAuthorityClient
  completed: string[]
} {
  const digest = `sha256:${'a'.repeat(64)}`
  const currentSubject: DiscoveryApprovalSubject = {
    schemaVersion: '1.1.0', assetId: 'PRODUCT-PRD-1', prdRevision: digest, scopeDigest: digest,
    environment: 'test', baseOrigin: 'https://test.example.com', actor: 'auditor',
    expectedPageIdentity: {
      url: 'https://test.example.com/orders', title: '订单', heading: '订单列表',
      ariaSignals: ['main:订单列表'],
    },
    bootstrapIntentsDigest: digest,
    requests: [],
    actions: [{ actionId: 'ACTION-PREFLIGHT', operation: 'local-navigation', maxUses: 1, requestIds: [] }],
  }
  const grant: SignedDiscoveryGrant = {
    grantId: 'GRANT-DISCOVERY-1', issuer: 'test-authority', keyId: 'test-key', proofScope: 'local-os-user',
    approver: { subject: 'os-user:test', roles: ['e2e-approver'] }, subject: currentSubject,
    subjectDigest: digest, issuedAt: '2026-07-12T00:00:00.000Z', expiresAt: '2026-07-12T01:00:00.000Z',
    approvalContext: { schemaVersion: '1.0.0', subject: 'os-user:test', runId: 'RUN-1',
      approvalType: 'discovery', subjectDigest: digest, installationDigest: digest,
      origin: 'http://127.0.0.1:43210', issuedAt: '2026-07-12T00:00:00.000Z',
      expiresAt: '2026-07-12T01:00:00.000Z' },
    capabilities: [{
      capabilityId: 'CAPABILITY-PREFLIGHT-1', nonce: '0'.repeat(64), transport: 'browser-local', effect: 'read',
      actionId: 'ACTION-PREFLIGHT', operation: 'local-navigation',
      targetUrl: currentSubject.expectedPageIdentity.url, actor: currentSubject.actor,
      expectedPageIdentityDigest: digestText(
        'expected-page-identity/v1', canonicalizeJson(currentSubject.expectedPageIdentity),
      ),
      bootstrapIntentsDigest: currentSubject.bootstrapIntentsDigest, maxUses: 1,
    }],
    revocationSequence: 0, signature: 'signature',
  }
  const completed: string[] = []
  const authority: DiscoveryAuthorityClient = {
    async reserveForSubject(input) {
      if (canonicalizeJson(input.grant) !== canonicalizeJson(grant)
        || canonicalizeJson(input.currentSubject) !== canonicalizeJson(currentSubject)) {
        throw new Error('authorization mismatch')
      }
      return {
        reservationId: 'RESERVATION-PREFLIGHT-1', grantId: grant.grantId,
        capabilityId: grant.capabilities[0]!.capabilityId, actionId: input.actionId,
        attemptId: input.attemptId, status: 'reserved', reservedAt: '2026-07-12T00:00:00.000Z',
      }
    },
    async completeDiscoveryPreflight(input) {
      completed.push(input.reservationId)
      return digestText('browser-preflight-result/v1', canonicalizeJson(input))
    },
  }
  return { grant, currentSubject, authority, completed }
}
