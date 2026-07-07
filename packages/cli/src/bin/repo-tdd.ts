#!/usr/bin/env node
import { repoTddWorkflow, resolveRepoTddSkillDirectory } from '../index.js'

const skillDir = resolveRepoTddSkillDirectory(process.argv.slice(2))
await repoTddWorkflow({ cwd: process.cwd(), skillDir })
