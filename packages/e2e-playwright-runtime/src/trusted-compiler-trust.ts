import { constants } from 'node:fs'
import { access, readFile, realpath, stat } from 'node:fs/promises'
import {
  type ApprovalFreshnessReceipt,
  type ApprovalFreshnessVerifierMaterial,
  type ArtifactAuthorityVerifierMaterial,
  type ArtifactDocument,
  type RegressionDiscoveryAttestation,
  type RegressionDiscoverySubject,
  type RegressionDiscoveryVerifierMaterial,
  digestBytes,
  digestText,
} from '@mutil-skills/e2e-contracts'
import {
  createApprovalFreshnessVerifier,
  createArtifactSignatureVerifier,
  getTrustedApprovalFreshnessClientKind,
  verifyTrustedApprovalFreshnessCurrent,
  type TrustedApprovalFreshnessClient,
} from '@mutil-skills/e2e-authority'
import {
  inspectTrustedCompilerReadiness,
  type TrustedCompilerReadiness,
} from '@mutil-skills/e2e-engine'
import { createRegressionDiscoveryVerifier } from './regression-discovery.js'

export interface TrustedCompilerProjectorTrust {}
export interface TrustedCompilerExecutionTrust {}
export interface TrustedCompilerRuntimeMeasurement {}

export interface TrustedCompilerRuntimeMeasurementFact {
  browserExecutableDigest: string
  gatewayProxyEndpointDigest: string
}

interface ProjectorTrustBinding {
  verifyArtifact(signature: ArtifactDocument['signatures'][number]): boolean
  verifyApprovalFreshness(receipt: ApprovalFreshnessReceipt): boolean
  readiness: {
    assetId: string
    generationId: string
    prdRevision: string
    scopeDigest: string
    lineageDecisionDigest: string
    contractsVersion: string
    prdManifestArtifactDigest: string
    prdDiffArtifactDigest: string
    acceptanceScopeArtifactDigest: string
  }
}

interface ExecutionTrustBinding {
  verifyDiscovery(attestation: RegressionDiscoveryAttestation, subject: RegressionDiscoverySubject): boolean
  approvalFreshnessClient: TrustedApprovalFreshnessClient
  approvalFreshnessClientKind: 'authority-state' | 'test-only-fixed-clock'
  browserExecutablePath: string
  browserExecutableDigest: string
  gatewayProxyEndpoint: string
}

const projectorTrust = new WeakMap<object, ProjectorTrustBinding>()
const executionTrust = new WeakMap<object, ExecutionTrustBinding>()
const runtimeMeasurements = new WeakMap<object, TrustedCompilerRuntimeMeasurementFact>()

/** 只允许受信 Host 在启动期调用；业务请求不得携带或替换这些信任根。 */
export function createTrustedCompilerProjectorTrust(input: {
  artifactAuthority: { material: ArtifactAuthorityVerifierMaterial; expectedPublicKeyDigest: string }
  approvalFreshnessAuthority: { material: ApprovalFreshnessVerifierMaterial; expectedPublicKeyDigest: string }
  readiness: TrustedCompilerReadiness
}): TrustedCompilerProjectorTrust {
  const readiness = inspectTrustedCompilerReadiness(input.readiness)
  if (!readiness) throw new Error('E2E_COMPILER_READINESS_INVALID')
  const verifyArtifact = createArtifactSignatureVerifier(
    input.artifactAuthority.material, input.artifactAuthority.expectedPublicKeyDigest,
  )
  const verifyApprovalFreshness = createApprovalFreshnessVerifier(
    input.approvalFreshnessAuthority.material, input.approvalFreshnessAuthority.expectedPublicKeyDigest,
  )
  const trust = Object.freeze({})
  projectorTrust.set(trust, { verifyArtifact, verifyApprovalFreshness, readiness })
  return trust
}

/** 只允许受信 Host 在启动期调用；浏览器与 Gateway 在这里固定并测量，不能逐 Run 自选。 */
export async function createTrustedCompilerExecutionTrust(input: {
  discoveryAuthority: { material: RegressionDiscoveryVerifierMaterial; expectedPublicKeyDigest: string }
  approvalFreshnessClient: TrustedApprovalFreshnessClient
  browserExecutablePath: string
  gatewayProxyEndpoint: string
}): Promise<TrustedCompilerExecutionTrust> {
  const browserExecutablePath = await realpath(input.browserExecutablePath)
  const browserStat = await stat(browserExecutablePath)
  await access(browserExecutablePath, constants.R_OK | constants.X_OK)
  if (!browserStat.isFile()) throw new Error('E2E_TRUST_BROWSER_EXECUTABLE_INVALID')
  const proxy = new URL(input.gatewayProxyEndpoint)
  if (proxy.protocol !== 'http:' || proxy.hostname !== '127.0.0.1' || proxy.pathname !== '/'
    || proxy.username || proxy.password || proxy.search || proxy.hash || !proxy.port) {
    throw new Error('E2E_TRUST_GATEWAY_PROXY_INVALID')
  }
  const browserBytes = await readFile(browserExecutablePath)
  const approvalFreshnessClientKind = getTrustedApprovalFreshnessClientKind(input.approvalFreshnessClient)
  if (!approvalFreshnessClientKind) throw new Error('E2E_TRUST_APPROVAL_CLIENT_INVALID')
  const trust = Object.freeze({})
  executionTrust.set(trust, {
    verifyDiscovery: createRegressionDiscoveryVerifier(
      input.discoveryAuthority.material, input.discoveryAuthority.expectedPublicKeyDigest,
    ),
    approvalFreshnessClient: input.approvalFreshnessClient,
    approvalFreshnessClientKind,
    browserExecutablePath,
    browserExecutableDigest: digestBytes('trusted-browser-executable/v1', browserBytes),
    gatewayProxyEndpoint: proxy.href,
  })
  return trust
}

export function getProjectorTrustBinding(value: unknown): ProjectorTrustBinding | undefined {
  return value && typeof value === 'object' ? projectorTrust.get(value as object) : undefined
}

export function getExecutionTrustBinding(value: unknown): ExecutionTrustBinding | undefined {
  return value && typeof value === 'object' ? executionTrust.get(value as object) : undefined
}

/** 在 Run 执行前从 Host 固定的 execution trust 独立派生测量能力。 */
export function captureTrustedCompilerRuntimeMeasurement(
  value: TrustedCompilerExecutionTrust,
): TrustedCompilerRuntimeMeasurement {
  const binding = getExecutionTrustBinding(value)
  if (!binding) throw new Error('E2E_TRUST_RUNTIME_MEASUREMENT_SOURCE_INVALID')
  const measurement = Object.freeze({})
  runtimeMeasurements.set(measurement, {
    browserExecutableDigest: binding.browserExecutableDigest,
    gatewayProxyEndpointDigest: digestText('trusted-gateway-proxy-endpoint/v1', binding.gatewayProxyEndpoint),
  })
  return measurement
}

export function inspectTrustedCompilerRuntimeMeasurement(
  value: unknown,
): TrustedCompilerRuntimeMeasurementFact | undefined {
  return value && typeof value === 'object'
    ? structuredClone(runtimeMeasurements.get(value as object))
    : undefined
}

export function verifyExecutionApprovalCurrent(
  binding: ExecutionTrustBinding,
  receipt: ApprovalFreshnessReceipt,
): boolean {
  return verifyTrustedApprovalFreshnessCurrent(binding.approvalFreshnessClient, receipt)
}
