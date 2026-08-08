import { chmod, lstat, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'

const RELEASE_CONTROL_KEYS = [
  'E2E_RUNTIME_RUN_TODOMVC_PUBLIC',
  'E2E_RUNTIME_TODOMVC_ONLY',
]
const ENVIRONMENT_PATTERN = /(?:E2E_(?:RUNTIME_(?:NODE_VERSION_UNSUPPORTED|PLATFORM_UNSUPPORTED|TEMP_DIRECTORY_UNAVAILABLE|NOT_INSTALLED|SYSTEM_CHROME_REQUIRED)|GATEWAY_(?:PATH_UNAVAILABLE|LOOPBACK_UNAVAILABLE|UNAVAILABLE)|CHROMIUM_NOT_INSTALLED|SYSTEM_CHROME_REVALIDATION_REQUIRED)|\b(?:ENOENT|ENOTFOUND|ECONNREFUSED|EACCES|EPERM)\b|Chrome executable|Node\.js|TMPDIR|npm (?:install|ERR!))/i
const SAFETY_PATTERN = /(?:E2E_RELEASE_SAFETY:|E2E_GATEWAY_(?:REQUEST_OUT_OF_ORDER|CAPABILITY_NOT_IN_GRANT|METHOD_NOT_READ_ONLY|DEFAULT_DENY|BROWSER_REQUEST_DENIED|CREDENTIALS_DENIED|PROTOCOL_FORBIDDEN|SCHEME_DENIED)|CAPABILITY_NOT_IN_GRANT|METHOD_NOT_READ_ONLY)/i
const INTERNAL_PATTERN = /(?:Cannot find module|Vitest|suite setup|SyntaxError|ERR_MODULE_NOT_FOUND)/i

export function classifyReleaseFailures(phase, failures) {
  if (!phase.includes('golden')) return 'environment'
  const message = failures.map((failure) => `${failure.test}\n${failure.message}`).join('\n')
  if (message.includes('E2E_RELEASE_BUSINESS:')) return 'business'
  if (message.includes('E2E_RELEASE_ENVIRONMENT:')) return 'environment'
  if (SAFETY_PATTERN.test(message)) return 'safety'
  if (INTERNAL_PATTERN.test(message)) return 'release-internal'
  if (ENVIRONMENT_PATTERN.test(message)) return 'environment'
  return 'release-internal'
}

export function releaseChildEnvironment(inherited, overrides = {}) {
  const environment = { ...inherited }
  for (const key of RELEASE_CONTROL_KEYS) delete environment[key]
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete environment[key]
    else environment[key] = value
  }
  return environment
}

export async function removeOwnedTemporaryTree(root) {
  const metadata = await lstat(root).catch((error) => {
    if (error?.code === 'ENOENT') return undefined
    throw error
  })
  if (metadata === undefined) return
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error('E2E_RELEASE_TEMP_ROOT_INVALID')
  }
  await makeOwnedDirectoriesWritable(root)
  await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
}

async function makeOwnedDirectoriesWritable(directory) {
  const metadata = await lstat(directory)
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) return
  await chmod(directory, 0o700)
  const entries = await readdir(directory, { withFileTypes: true })
  for (const entry of entries) {
    if (entry.isDirectory() && !entry.isSymbolicLink()) {
      await makeOwnedDirectoriesWritable(join(directory, entry.name))
    }
  }
}
