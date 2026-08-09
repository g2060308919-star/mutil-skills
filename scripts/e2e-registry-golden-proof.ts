import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve, sep } from 'node:path'
import { z } from 'zod'
import { createRegistryGoldenArtifact } from '../packages/e2e-runtime/src/registry-golden-proof.js'

const manifestPath = resolve(required('E2E_REGISTRY_GOLDEN_MATRIX_MANIFEST'))
const manifest = z.object({ results: z.array(z.object({
  platform: z.enum(['darwin', 'linux']), arch: z.enum(['arm64', 'x64']),
  nodeMajor: z.union([z.literal(22), z.literal(24)]), path: z.string().min(1),
}).strict()).length(4) }).strict().parse(JSON.parse(await readFile(manifestPath, 'utf8')))
const manifestRoot = dirname(manifestPath)
const proof = createRegistryGoldenArtifact({
  runtimeVersion: required('E2E_REGISTRY_GOLDEN_RUNTIME_VERSION'),
  installationDigest: required('E2E_REGISTRY_GOLDEN_INSTALLATION_DIGEST'),
  sourceCommit: required('E2E_REGISTRY_GOLDEN_SOURCE_COMMIT'),
  results: await Promise.all(manifest.results.map(async (item) => ({ ...item,
    result: JSON.parse(await readFile(resultPath(item.path), 'utf8')) }))),
})
const outputPath = resolve(required('E2E_REGISTRY_GOLDEN_PROOF_OUTPUT'))
await mkdir(dirname(outputPath), { recursive: true, mode: 0o700 })
await writeFile(outputPath, `${JSON.stringify(proof, null, 2)}\n`, { mode: 0o600 })
process.stdout.write(`${JSON.stringify({ ok: true, outputPath, proofDigest: proof.proofDigest })}\n`)

function required(name: string): string {
  const value = process.env[name]
  if (value === undefined || value.trim() === '') throw new Error(`E2E_REGISTRY_GOLDEN_ENV_REQUIRED:${name}`)
  return value
}
function resultPath(candidate: string): string {
  const path = resolve(manifestRoot, candidate)
  if (!path.startsWith(`${manifestRoot}${sep}`)) throw new Error('E2E_REGISTRY_GOLDEN_RESULT_PATH_OUTSIDE_MANIFEST')
  return path
}
