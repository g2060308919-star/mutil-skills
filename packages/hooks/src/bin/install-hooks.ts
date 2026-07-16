#!/usr/bin/env node
import { installHooksCommand } from '../runtime/cli.js'

try {
  process.stdout.write(`${await installHooksCommand(process.argv.slice(2))}\n`)
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : 'Hook installation failed'}\n`)
  process.exitCode = 1
}
