#!/usr/bin/env node
import { telemetryHookCommand, verificationSinkFromEnvironment } from '../telemetry.js'

try {
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk))
  await telemetryHookCommand(
    process.argv.slice(2),
    Buffer.concat(chunks).toString('utf8'),
    { sink: verificationSinkFromEnvironment(process.env) },
  )
} catch {
  // Hooks must fail open and must not expose sensitive payloads in diagnostics.
  process.stderr.write('mutil-skills telemetry hook failed\n')
}
