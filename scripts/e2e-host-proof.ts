import {
  assertRequiredHostCapabilities,
  probeHostCapabilities,
  type HostCapabilityName,
} from '../packages/e2e-runtime/src/host-capability-proof.js'
import { createSupportedHostProofFromCapabilityProof } from '../packages/e2e-runtime/src/supported-host-proof.js'
import { mkdir, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

const known = new Set<HostCapabilityName>([
  'loopback', 'process', 'filesystem', 'browser', 'profile', 'sandbox', 'gateway-canary',
])
const requiredArgument = process.argv.slice(2).find((argument) => argument.startsWith('--require='))
const required = (requiredArgument?.slice('--require='.length) ?? 'process,filesystem')
  .split(',').filter(Boolean)
if (required.some((name) => !known.has(name as HostCapabilityName))) {
  process.stderr.write(`${JSON.stringify({
    ok: false, code: 'E2E_HOST_CAPABILITY_NAME_INVALID', required,
  })}\n`)
  process.exitCode = 2
} else {
  const capabilityProof = await probeHostCapabilities()
  const proof = createSupportedHostProofFromCapabilityProof({ capabilityProof })
  const outputPath = resolve(process.env.E2E_HOST_PROOF_OUTPUT
    ?? join(homedir(), '.mutil-skills', 'e2e', 'proofs', 'host-capability-proof.json'))
  await mkdir(dirname(outputPath), { recursive: true, mode: 0o700 })
  await writeFile(outputPath, `${JSON.stringify(proof, null, 2)}\n`, { mode: 0o600 })
  try {
    assertRequiredHostCapabilities(capabilityProof, required as HostCapabilityName[])
    process.stdout.write(`${JSON.stringify({
      ok: true, outputPath, proofDigest: proof.proofDigest, required,
    })}\n`)
  } catch (error) {
    process.stderr.write(`${JSON.stringify({
      ok: false,
      outputPath,
      proofDigest: proof.proofDigest,
      required,
      code: typeof error === 'object' && error !== null && 'code' in error ? error.code : 'E2E_HOST_PROOF_FAILED',
    })}\n`)
    process.exitCode = 1
  }
}
