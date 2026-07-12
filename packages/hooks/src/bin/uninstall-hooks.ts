#!/usr/bin/env node
import { uninstallHooksCommand } from '../runtime/cli.js'

try {
  process.stdout.write(`${await uninstallHooksCommand(process.argv.slice(2))}\n`)
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : 'Hook uninstallation failed'}\n`)
  process.exitCode = 1
}
