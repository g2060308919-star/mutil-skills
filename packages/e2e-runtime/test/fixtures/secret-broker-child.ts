import { createHash } from 'node:crypto'
import { RuntimeSecretBroker } from '../../src/secret-broker.js'

const [mode, homeDir, projectRoot] = process.argv.slice(2)
if ((mode !== 'provide' && mode !== 'consume') || !homeDir || !projectRoot) process.exit(64)

let broker: RuntimeSecretBroker | undefined
try {
  broker = await RuntimeSecretBroker.open({ homeDir, projectRoot })
  if (mode === 'provide') {
    const value = Buffer.from('os-process-secret-canary')
    try { await broker.provide({ runId: 'RUN-OS', secretRef: 'PASSWORD', value }) }
    finally { value.fill(0) }
    process.stdout.write('stored\n')
  } else {
    const handle = await broker.resolve({ runId: 'RUN-OS', secretRef: 'PASSWORD' })
    const value = await broker.consume(handle)
    try { process.stdout.write(`${createHash('sha256').update(value).digest('hex')}\n`) }
    finally { value.fill(0) }
  }
  await broker.close()
} catch (error) {
  await broker?.close().catch(() => undefined)
  const code = typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code: unknown }).code)
    : 'E2E_SECRET_CHILD_FAILED'
  process.stderr.write(`${code}\n`)
  process.exitCode = 2
}
