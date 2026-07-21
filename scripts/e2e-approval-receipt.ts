import { digestText } from '@mutil-skills/e2e-contracts'

export interface GoldenApprovalExpectation {
  approvalType: 'discovery' | 'execution'
  subjectDigest: string
}

/**
 * 黄金 E2E 的可信认证边界替身。它返回与生产 WebAuthn receipt 相同的完整绑定，
 * 避免测试通过旧的“只返回 subject”快捷方式绕过 run、安装、origin 与 TTL 语义。
 */
export function createGoldenApprovalReceipt(
  subject: string,
  runId: string,
  expected: GoldenApprovalExpectation,
  issuedAt = '2026-07-11T09:59:00.000Z',
) {
  return {
    subject,
    runId,
    approvalType: expected.approvalType,
    subjectDigest: expected.subjectDigest,
    installationDigest: digestText('golden-runtime-installation/v1', 'portable-e2e-runtime'),
    origin: 'http://127.0.0.1:43210',
    issuedAt,
    expiresAt: new Date(Date.parse(issuedAt) + 2 * 60_000).toISOString(),
  }
}
