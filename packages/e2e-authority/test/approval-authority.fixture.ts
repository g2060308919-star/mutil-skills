import { LocalApprovalAuthority as RuntimeApprovalAuthority } from '../src/index.js'

type CreateOptions = Parameters<typeof RuntimeApprovalAuthority.create>[0]

export function testApprovalReceipt(
  subject: string,
  expected: { approvalType: 'discovery' | 'execution'; subjectDigest: string },
) {
  return {
    subject,
    runId: 'RUN-TEST',
    approvalType: expected.approvalType,
    subjectDigest: expected.subjectDigest,
    installationDigest: `sha256:${'a'.repeat(64)}`,
    origin: 'http://127.0.0.1:43210',
    issuedAt: '2026-01-01T00:00:00.000Z',
    expiresAt: '2099-01-01T00:00:00.000Z',
  }
}

/** 测试可信身份注册表；生产调用方必须显式提供自己的认证结果。 */
export const LocalApprovalAuthority = {
  create(options: CreateOptions): RuntimeApprovalAuthority {
    const authority = RuntimeApprovalAuthority.create({
      ...options,
      authenticateApproverSession: options.authenticateApproverSession
        ?? ((sessionRef, expected) => sessionRef.startsWith('test-session:')
          ? testApprovalReceipt(sessionRef.slice('test-session:'.length), expected)
          : undefined),
      approvalIdentities: options.approvalIdentities ?? [
        { subject: 'alice', roles: ['e2e-approver'] },
        { subject: 'os-user:qa', roles: ['e2e-approver'] },
        { subject: 'os-user:zhangxudong', roles: ['e2e-approver'] },
      ],
    })
    const issuance = new Set([
      'issueDiscoveryGrant', 'issueReadGrant', 'issueWriteGrant',
      'issueInjectionGrant', 'issueWebSocketReadGrant', 'issueSseReadGrant',
    ])
    return new Proxy(authority, {
      get(target, property) {
        const value = Reflect.get(target, property, target)
        if (typeof property === 'string' && issuance.has(property) && typeof value === 'function') {
          return (input: { approver: { subject: string } }) => value.call(target, {
            ...input, approvalSessionRef: `test-session:${input.approver.subject}`,
          })
        }
        return typeof value === 'function' ? value.bind(target) : value
      },
    })
  },
}

export type LocalApprovalAuthority = RuntimeApprovalAuthority
