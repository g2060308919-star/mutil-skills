import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { chmod, lstat, mkdir, readFile, realpath, rename, unlink, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const PINNED_VERSION = '13.3.0'
const PINNED_SOURCE_DIGEST = 'cf4469953efcb5617a870ae3f022b3ad48aee8c06012ccdafcabc73058f123a0'
const PINNED_LICENSE_DIGEST = 'bd9e3f45696472076c7160c7f66e54b2d62d38bc2646c812d19be83ee4400c63'
const BUNDLE_PATH = 'dist/bundle/index.umd.min.js'
const LICENSE_PATH = 'LICENSE.md'

export async function copyApprovalAssets(options = {}) {
  const sourcePackageRoot = options.sourcePackageRoot ?? await resolveInstalledPackageRoot()
  const targetRoot = options.targetRoot ?? fileURLToPath(new URL('../assets/approval/', import.meta.url))
  const packageRoot = await realpath(sourcePackageRoot)
  const manifestPath = join(packageRoot, 'package.json')
  const manifest = await readJson(manifestPath)
  if (manifest.name !== '@simplewebauthn/browser' || manifest.version !== PINNED_VERSION) {
    throw assetError('E2E_APPROVAL_ASSET_VERSION_MISMATCH')
  }

  const sourceBytes = await readPinnedSource(packageRoot, BUNDLE_PATH, PINNED_SOURCE_DIGEST)
  const licenseBytes = await readPinnedSource(packageRoot, LICENSE_PATH, PINNED_LICENSE_DIGEST)

  await mkdir(targetRoot, { recursive: true, mode: 0o755 })
  const targetDirectory = await realpath(targetRoot)
  const targetDigest = await copyOrVerifyTarget(
    targetDirectory, 'simplewebauthn-browser.js', sourceBytes, PINNED_SOURCE_DIGEST,
  )
  const licenseDigest = await copyOrVerifyTarget(
    targetDirectory, 'simplewebauthn-LICENSE.md', licenseBytes, PINNED_LICENSE_DIGEST,
  )
  return { version: PINNED_VERSION, sourceDigest: PINNED_SOURCE_DIGEST, targetDigest, licenseDigest }
}

async function readPinnedSource(packageRoot, relativePath, expectedDigest) {
  const sourcePath = join(packageRoot, relativePath)
  const sourceStat = await lstat(sourcePath)
  const sourceRealpath = await realpath(sourcePath)
  if (!sourceStat.isFile() || sourceStat.isSymbolicLink() || sourceRealpath !== sourcePath
    || !isWithin(packageRoot, sourceRealpath)) {
    throw assetError('E2E_APPROVAL_ASSET_SOURCE_REALPATH_INVALID')
  }
  const bytes = await readFile(sourceRealpath)
  if (digest(bytes) !== expectedDigest) throw assetError('E2E_APPROVAL_ASSET_SOURCE_DIGEST_MISMATCH')
  return bytes
}

async function copyOrVerifyTarget(targetDirectory, name, sourceBytes, sourceDigest) {
  const targetPath = join(targetDirectory, name)
  try {
    const targetStat = await lstat(targetPath)
    const targetRealpath = await realpath(targetPath)
    if (!targetStat.isFile() || targetStat.isSymbolicLink() || targetRealpath !== targetPath
      || !isWithin(targetDirectory, targetRealpath)) {
      throw assetError('E2E_APPROVAL_ASSET_TARGET_REALPATH_INVALID')
    }
    if (digest(await readFile(targetRealpath)) !== sourceDigest) {
      throw assetError('E2E_APPROVAL_ASSET_TARGET_DRIFT')
    }
  } catch (error) {
    if (!isMissing(error)) throw error
    const staging = join(targetDirectory, `.${name}.${process.pid}.tmp`)
    try {
      await writeFile(staging, sourceBytes, { flag: 'wx', mode: 0o644 })
      await chmod(staging, 0o644)
      await rename(staging, targetPath)
    } finally {
      await unlink(staging).catch((cleanupError) => {
        if (!isMissing(cleanupError)) throw cleanupError
      })
    }
  }

  const targetRealpath = await realpath(targetPath)
  if (targetRealpath !== targetPath || !isWithin(targetDirectory, targetRealpath)) {
    throw assetError('E2E_APPROVAL_ASSET_TARGET_REALPATH_INVALID')
  }
  const targetDigest = digest(await readFile(targetRealpath))
  if (targetDigest !== sourceDigest) throw assetError('E2E_APPROVAL_ASSET_TARGET_DIGEST_MISMATCH')
  return targetDigest
}

async function resolveInstalledPackageRoot() {
  const require = createRequire(import.meta.url)
  const entrypoint = await realpath(require.resolve('@simplewebauthn/browser'))
  const root = dirname(dirname(entrypoint))
  if (!isWithin(root, entrypoint)) throw assetError('E2E_APPROVAL_ASSET_SOURCE_REALPATH_INVALID')
  return root
}

async function readJson(path) {
  let value
  try { value = JSON.parse(await readFile(path, 'utf8')) } catch (cause) {
    throw assetError('E2E_APPROVAL_ASSET_MANIFEST_INVALID', cause)
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw assetError('E2E_APPROVAL_ASSET_MANIFEST_INVALID')
  }
  return value
}

function digest(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

function isWithin(root, candidate) {
  const path = relative(root, candidate)
  return path !== '' && path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path)
}

function isMissing(error) {
  return typeof error === 'object' && error !== null && error.code === 'ENOENT'
}

function assetError(code, cause) {
  return Object.assign(new Error(code, cause === undefined ? undefined : { cause }), { code })
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await copyApprovalAssets()
}
