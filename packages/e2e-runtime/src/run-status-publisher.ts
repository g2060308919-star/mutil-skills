import { RuntimeStatusResultSchema, E2EError, type RuntimeStatusResult } from '@mutil-skills/e2e-contracts'
import { renderRunStatus } from '@mutil-skills/e2e-report'
import { chmod, lstat, mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { join, resolve } from 'node:path'

const SAFE_ID = /^[A-Za-z0-9._:-]{1,256}$/

export class RunStatusPublisher {
  readonly #homeDir: string

  constructor(options: { homeDir: string }) {
    this.#homeDir = resolve(options.homeDir)
  }

  async publish(input: RuntimeStatusResult): Promise<string> {
    const status = RuntimeStatusResultSchema.parse(input)
    if (!SAFE_ID.test(status.assetId) || !SAFE_ID.test(status.runId)) {
      throw publisherError('E2E_RUN_STATUS_ID_INVALID')
    }
    const root = join(
      this.#homeDir, '.mutil-skills', 'e2e', 'runs', status.assetId, status.runId,
    )
    await ensurePrivatePath(this.#homeDir, [
      '.mutil-skills', 'e2e', 'runs', status.assetId, status.runId,
    ])
    const rendered = renderRunStatus(status)
    await Promise.all([
      writeAtomic(root, 'run-status.json', rendered.json),
      writeAtomic(root, 'run-status.md', rendered.markdown),
      writeAtomic(root, 'run-status.html', rendered.html),
    ])
    return root
  }
}

async function ensurePrivatePath(base: string, segments: string[]): Promise<void> {
  let current = base
  for (const segment of segments) {
    current = join(current, segment)
    const before = await lstat(current).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return undefined
      throw error
    })
    if (before === undefined) await mkdir(current, { mode: 0o700 })
    const info = await lstat(current)
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw publisherError('E2E_RUN_STATUS_PATH_UNSAFE')
    }
    await chmod(current, 0o700)
  }
}

async function writeAtomic(root: string, name: string, value: string): Promise<void> {
  const temporary = join(root, `.${name}.${randomUUID()}.tmp`)
  try {
    await writeFile(temporary, value, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
    await rename(temporary, join(root, name))
    await chmod(join(root, name), 0o600)
  } finally {
    await rm(temporary, { force: true })
  }
}

function publisherError(code: string): E2EError {
  return new E2EError({ code, category: 'safety', message: code, retryable: false })
}
