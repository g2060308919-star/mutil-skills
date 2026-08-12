import { createHash } from 'node:crypto'

export function buildReleaseProof(input) {
  const reasonCodes = []
  if (!input.worktreeClean) reasonCodes.push('E2E_RELEASE_WORKTREE_DIRTY')
  if (input.tarballs.length === 0) reasonCodes.push('E2E_RELEASE_TARBALLS_MISSING')
  if (input.packageClosure.length === 0) reasonCodes.push('E2E_RELEASE_PACKAGE_CLOSURE_MISSING')
  if (input.skippedTests !== 0) reasonCodes.push('E2E_RELEASE_GOLDEN_SKIPPED')
  if (!input.hostProof.gateEligible) reasonCodes.push('E2E_RELEASE_HOST_UNVERIFIED')
  if (input.phases.some((phase) => phase.status !== 'passed')) reasonCodes.push('E2E_RELEASE_PHASE_FAILED')
  if (input.golden.workspace !== 'passed'
    || (input.mode === 'registry' && input.golden.registry !== 'passed')) reasonCodes.push('E2E_RELEASE_GOLDEN_FAILED')
  const body = {
    schemaVersion: 'e2e-release-proof/v1', ...input,
    conclusion: { gateEligible: reasonCodes.length === 0, reasonCodes: [...new Set(reasonCodes)].sort() },
  }
  return { ...body, proofDigest: digest('e2e-release-proof/v1', canonicalize(body)) }
}

export function digestReleaseBytes(bytes) {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`
}

function digest(domain, value) {
  return `sha256:${createHash('sha256').update(`${domain}\0${value}`).digest('hex')}`
}

function canonicalize(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`
  if (value !== null && typeof value === 'object') return `{${Object.keys(value).sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`).join(',')}}`
  return JSON.stringify(value)
}
