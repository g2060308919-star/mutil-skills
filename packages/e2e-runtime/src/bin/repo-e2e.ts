#!/usr/bin/env node
import { runRuntimeBin } from '../runtime-bin.js'

process.exitCode = await runRuntimeBin(
  process.argv.slice(2),
  process.stdin,
  process.stdout,
  process.stderr,
)
