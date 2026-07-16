import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open, realpath } from 'node:fs/promises'
import { dirname, join, parse } from 'node:path'
import { digestText, E2EError } from '@mutil-skills/e2e-contracts'

const CANDIDATES = ['/usr/bin/python3', '/usr/local/bin/python3', '/opt/homebrew/bin/python3'] as const
const MAX_PROBE_BYTES = 8 * 1024
const PROBE = [
  'import json, os, sys',
  'required = [os.open, os.mkdir, os.stat, os.unlink]',
  'ok = all(item in os.supports_dir_fd for item in required)',
  'ok = ok and all(hasattr(os, name) for name in ("O_NOFOLLOW", "fchdir", "pread", "pwrite", "fsync"))',
  'print(json.dumps({"ok": ok, "version": list(sys.version_info[:3])}, sort_keys=True, separators=(",", ":")))',
].join(';')

export interface TrustedPythonRuntime {
  executable: string
  device: string
  inode: string
  size: string
  modifiedNanoseconds: string
  contentDigest: string
  version: string
  proofDigest: string
}

export async function discoverTrustedPython(): Promise<TrustedPythonRuntime> {
  for (const candidate of CANDIDATES) {
    try { return await inspectTrustedPython(candidate) }
    catch { /* 固定候选逐个 fail closed；不读取 PATH 或调用 shell */ }
  }
  throw pythonError('E2E_RUNTIME_TRUSTED_PYTHON_UNAVAILABLE')
}

export async function reverifyTrustedPython(runtime: TrustedPythonRuntime): Promise<void> {
  const current = await inspectTrustedPython(runtime.executable)
  if (current.proofDigest !== runtime.proofDigest) {
    throw pythonError('E2E_RUNTIME_TRUSTED_PYTHON_REBOUND')
  }
}

async function inspectTrustedPython(candidate: string): Promise<TrustedPythonRuntime> {
  const candidateMetadata = await lstat(candidate)
  const resolved = await realpath(candidate)
  const pathMetadata = await lstat(resolved)
  if ((!candidateMetadata.isFile() && !candidateMetadata.isSymbolicLink())
    || candidateMetadata.uid !== 0 || !pathMetadata.isFile()
    || pathMetadata.isSymbolicLink() || pathMetadata.uid !== 0 || (pathMetadata.mode & 0o022) !== 0) {
    throw pythonError('E2E_RUNTIME_TRUSTED_PYTHON_INVALID')
  }
  await assertTrustedPathAncestors(resolved)
  const handle = await open(resolved, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  let bytes: Buffer | undefined
  try {
    const descriptorMetadata = await handle.stat({ bigint: true })
    if (!descriptorMetadata.isFile() || descriptorMetadata.uid !== 0n
      || (descriptorMetadata.mode & 0o22n) !== 0n
      || descriptorMetadata.dev.toString() !== pathMetadata.dev.toString()
      || (resolved !== '/usr/bin/python3'
        && descriptorMetadata.ino.toString() !== pathMetadata.ino.toString())) {
      throw pythonError('E2E_RUNTIME_TRUSTED_PYTHON_INVALID')
    }
    bytes = await handle.readFile()
    const contentDigest = `sha256:${createHash('sha256').update(bytes).digest('hex')}`
    const probe = await probePython(resolved)
    const identity = {
      executable: resolved,
      device: descriptorMetadata.dev.toString(),
      inode: descriptorMetadata.ino.toString(),
      size: descriptorMetadata.size.toString(),
      modifiedNanoseconds: descriptorMetadata.mtimeNs.toString(),
      contentDigest,
      version: probe.version,
    }
    return { ...identity, proofDigest: digestText('e2e-trusted-python-runtime/v1', JSON.stringify(identity)) }
  } finally {
    bytes?.fill(0)
    await handle.close()
  }
}

async function assertTrustedPathAncestors(path: string): Promise<void> {
  const parsed = parse(path)
  const parts = dirname(path).slice(parsed.root.length).split('/').filter(Boolean)
  let current = parsed.root
  for (const part of parts) {
    current = join(current, part)
    const metadata = await lstat(current)
    if (!metadata.isDirectory() || metadata.isSymbolicLink() || metadata.uid !== 0
      || (metadata.mode & 0o022) !== 0) {
      throw pythonError('E2E_RUNTIME_TRUSTED_PYTHON_ANCESTOR_INVALID')
    }
  }
}

async function probePython(executable: string): Promise<{ version: string }> {
  const child = spawn(executable, ['-I', '-S', '-c', PROBE], {
    stdio: ['ignore', 'pipe', 'ignore'],
    env: { LANG: 'C.UTF-8', PATH: '/usr/bin:/bin' },
  })
  const chunks: Buffer[] = []
  let size = 0
  let overflow = false
  child.stdout.on('data', (chunk: Buffer) => {
    const copy = Buffer.from(chunk)
    size += copy.byteLength
    if (size > MAX_PROBE_BYTES) { copy.fill(0); overflow = true; child.kill('SIGKILL') }
    else chunks.push(copy)
  })
  const exitCode = await new Promise<number | null>((resolve, reject) => {
    const timeout = setTimeout(() => { overflow = true; child.kill('SIGKILL') }, 5_000)
    child.once('error', (error) => { clearTimeout(timeout); reject(error) })
    child.once('close', (code) => { clearTimeout(timeout); resolve(code) })
  })
  const output = Buffer.concat(chunks)
  for (const chunk of chunks) chunk.fill(0)
  try {
    if (overflow || exitCode !== 0) throw pythonError('E2E_RUNTIME_TRUSTED_PYTHON_PROBE_FAILED')
    const parsed = JSON.parse(output.toString('utf8')) as unknown
    if (!isRecord(parsed) || Object.keys(parsed).sort().join('\0') !== ['ok', 'version'].join('\0')
      || parsed.ok !== true || !Array.isArray(parsed.version) || parsed.version.length !== 3
      || parsed.version.some((part) => !Number.isSafeInteger(part))
      || parsed.version[0] !== 3 || parsed.version[1] < 9) {
      throw pythonError('E2E_RUNTIME_TRUSTED_PYTHON_CAPABILITY_MISSING')
    }
    return { version: parsed.version.join('.') }
  } finally { output.fill(0) }
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function pythonError(code: string): E2EError {
  return new E2EError({
    code, category: 'environment', message: `${code}: 未找到可固定、可复验且具备 dir_fd 能力的 Python 3`,
    retryable: false,
  })
}
