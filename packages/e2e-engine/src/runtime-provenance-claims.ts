import type { RuntimeProvenance } from '@mutil-skills/e2e-contracts'

export const LOCAL_AUTHORITY_STATE_CANNOT_CLAIM =
  '本地 Authority 状态保护不能证明抵抗已控制同一 OS 用户的整体回滚，也不构成组织级不可抵赖'

/**
 * 把运行时来源中的保护边界投影为报告的不可声称项。
 * 构建与独立审计必须共用同一投影，避免报告自行扩大可信边界。
 */
export function deriveRuntimeProvenanceCannotClaim(
  provenance: Pick<RuntimeProvenance, 'authorityStateProtectionLevel'>,
): string[] {
  return provenance.authorityStateProtectionLevel === 'local-crash-integrity'
    ? [LOCAL_AUTHORITY_STATE_CANNOT_CLAIM]
    : []
}
