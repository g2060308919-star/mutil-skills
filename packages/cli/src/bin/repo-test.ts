#!/usr/bin/env node
import { repoTest } from '../index.js'

const result = await repoTest({ cwd: process.cwd(), args: process.argv.slice(2) })
process.exitCode = result.exitCode
