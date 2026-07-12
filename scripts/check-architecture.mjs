import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'

const root = process.cwd()
const failures = []

await assertNoDomainTermsInCore()
await assertSkillsHaveNoRuntimeImports()
await assertFoundationHasNoBin()
await assertWorkspacePackages()

if (failures.length > 0) {
  for (const failure of failures) {
    console.error(failure)
  }
  process.exitCode = 1
}

async function assertNoDomainTermsInCore() {
  const files = await collect(join(root, 'packages/core/src'))
  const forbidden = /\b(tdd|skill|template|vitest|jest|foundation)\b/i
  for (const file of files) {
    const text = await readFile(file, 'utf8')
    if (forbidden.test(text)) {
      failures.push(`core contains domain term in ${file}`)
    }
  }
}

async function assertSkillsHaveNoRuntimeImports() {
  const files = await collect(join(root, 'packages/skills/src'))
  const forbidden = /@mutil-skills\/(cli|foundation|template)/
  for (const file of files) {
    const text = await readFile(file, 'utf8')
    if (forbidden.test(text)) {
      failures.push(`skills imports runtime package in ${file}`)
    }
  }
}

async function assertFoundationHasNoBin() {
  const pkg = JSON.parse(await readFile(join(root, 'packages/foundation/package.json'), 'utf8'))
  if (pkg.bin) failures.push('foundation package must not expose bin')
}

async function assertWorkspacePackages() {
  const packages = new Set(await readdir(join(root, 'packages')))
  for (const name of [
    'schema',
    'template',
    'skills',
    'cli',
    'core',
    'foundation',
    'hooks',
  ]) {
    if (!packages.has(name)) failures.push(`missing workspace package: ${name}`)
  }
}

async function collect(dir) {
  const entries = await readdir(dir, { withFileTypes: true })
  const files = []
  for (const entry of entries) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) files.push(...await collect(path))
    if (entry.isFile() && entry.name.endsWith('.ts')) files.push(path)
  }
  return files
}
