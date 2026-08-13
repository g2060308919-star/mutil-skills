import {
  SupportedHostProofV1Schema,
  computeSupportedHostProofDigest,
  type SupportedHostProofBodyV1,
  type SupportedHostProofV1,
} from '@mutil-skills/e2e-contracts'
import type { HostCapabilityProof, HostCapabilityResult } from './host-capability-proof.js'

export type CreateSupportedHostProofInput = Omit<SupportedHostProofBodyV1, 'schemaVersion' | 'conclusion'>

export function createSupportedHostProof(input: CreateSupportedHostProofInput): SupportedHostProofV1 {
  const capabilities = [input.chrome.capability, ...Object.values(input.capabilities)]
  const reasonCodes = capabilities.filter((item) => item.status !== 'executed').map((item) => item.reasonCode)
  if (input.executionEntry.status !== 'executed') reasonCodes.push('E2E_HOST_PUBLIC_JOURNEY_NOT_EXECUTED')
  const gateEligible = reasonCodes.length === 0
  const body: SupportedHostProofBodyV1 = {
    schemaVersion: 'supported-host-proof/v1', ...input,
    conclusion: {
      status: gateEligible ? 'supported' : 'unverified', gateEligible,
      reasonCodes: [...new Set(reasonCodes)].sort(),
    },
  }
  return SupportedHostProofV1Schema.parse({ ...body, proofDigest: computeSupportedHostProofDigest(body) })
}

export function createSupportedHostProofFromCapabilityProof(input: {
  capabilityProof: HostCapabilityProof
  executionEntry?: CreateSupportedHostProofInput['executionEntry']
}): SupportedHostProofV1 {
  const browser = input.capabilityProof.capabilities.browser
  const details = browser.details ?? {}
  const browserExecuted = browser.status === 'executed'
  return createSupportedHostProof({
    host: {
      platform: input.capabilityProof.environment.platform,
      arch: input.capabilityProof.environment.arch,
      nodeVersion: input.capabilityProof.environment.node.replace(/^v/, ''),
    },
    chrome: {
      channel: browserExecuted && (details.channel === 'chrome' || details.channel === 'chromium')
        ? details.channel : null,
      version: browserExecuted && typeof details.version === 'string' ? details.version : null,
      source: browserExecuted && (details.source === 'system-chrome' || details.source === 'managed-chromium')
        ? details.source : null,
      executableDigest: browserExecuted && typeof details.executableDigest === 'string'
        ? details.executableDigest : null,
      capability: projectCapability(browser),
    },
    capabilities: {
      sandbox: projectCapability(input.capabilityProof.capabilities.sandbox),
      loopback: projectCapability(input.capabilityProof.capabilities.loopback),
      process: projectCapability(input.capabilityProof.capabilities.process),
      filesystem: projectCapability(input.capabilityProof.capabilities.filesystem),
      profileIsolation: projectCapability(input.capabilityProof.capabilities.profile),
      gatewayCanary: projectCapability(input.capabilityProof.capabilities['gateway-canary']),
    },
    executionEntry: input.executionEntry ?? {
      kind: 'public-full-journey', status: 'not-executed',
      proofDigest: input.capabilityProof.proofDigest,
    },
  })
}

function projectCapability(capability: HostCapabilityResult) {
  return {
    status: capability.status, reasonCode: capability.reasonCode, proofDigest: capability.proofDigest,
  }
}
