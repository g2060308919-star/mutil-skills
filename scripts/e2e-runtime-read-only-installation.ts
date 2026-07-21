import { chmod, mkdir } from 'node:fs/promises'
import { runtimeLayout } from '../packages/e2e-runtime/src/runtime-layout.js'
import {
  inspectRuntimeCapabilityProof,
  recordRuntimeCapabilityProof,
  type RuntimeCapabilityProof,
} from '../packages/e2e-runtime/src/runtime-capability-proof.js'

/**
 * Golden 只迁移已经由源 HOME 的真实受控会话生成并通过完整性校验的 proof。
 * 重新落盘会生成目标 HOME 自己的原子 0600 文件，避免复制其他 Run/Authority state。
 */
export async function copyVerifiedCapabilityProof(
  sourceHome: string,
  targetHome: string,
  runtimeInstallationDigest: string,
): Promise<RuntimeCapabilityProof> {
  const source = await inspectRuntimeCapabilityProof({
    homeDir: sourceHome,
    runtimeInstallationDigest,
  })
  const targetState = runtimeLayout(targetHome).state
  await mkdir(targetState, { recursive: true, mode: 0o700 })
  await chmod(targetState, 0o700)
  await recordRuntimeCapabilityProof({
    homeDir: targetHome,
    runtimeInstallationDigest,
    gateway: source.gateway,
    isolation: source.isolation,
    verifiedAt: source.verifiedAt,
  })
  return await inspectRuntimeCapabilityProof({
    homeDir: targetHome,
    runtimeInstallationDigest,
  })
}
