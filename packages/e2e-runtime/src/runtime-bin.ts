import type { Readable, Writable } from 'node:stream'
import { runCli } from './cli.js'

export async function runRuntimeBin(
  arguments_: string[],
  stdin: Readable,
  stdout: Writable,
  stderr: Writable,
): Promise<number> {
  try {
    return await runCli(arguments_, stdin, stdout, stderr)
  } catch {
    await writeSanitizedInternalError(stderr)
    return 70
  }
}

async function writeSanitizedInternalError(stderr: Writable): Promise<void> {
  await new Promise<void>((resolve) => {
    let finished = false
    const finish = (): void => {
      if (finished) return
      finished = true
      stderr.off('error', finish)
      resolve()
    }
    stderr.once('error', finish)
    try {
      stderr.write('E2E_RUNTIME_INTERNAL_ERROR\n', finish)
    } catch {
      finish()
    }
  })
}
