#!/usr/bin/env node

let exitCode = 70

try {
  const { runRuntimeBin } = await import('../runtime-bin.js')
  exitCode = await runRuntimeBin(
    process.argv.slice(2),
    process.stdin,
    process.stdout,
    process.stderr,
  )
} catch {
  await writeSanitizedInternalError()
}

process.exitCode = exitCode

async function writeSanitizedInternalError(): Promise<void> {
  await new Promise<void>((resolve) => {
    let finished = false
    const finish = (): void => {
      if (finished) return
      finished = true
      process.stderr.off('error', finish)
      resolve()
    }
    process.stderr.once('error', finish)
    try {
      process.stderr.write('E2E_RUNTIME_INTERNAL_ERROR\n', finish)
    } catch {
      finish()
    }
  })
}
