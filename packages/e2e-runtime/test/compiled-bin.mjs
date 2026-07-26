import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const distSource = fileURLToPath(new URL('../dist/src/', import.meta.url))
const compiledBin = join(distSource, 'bin', 'repo-e2e.js')

assert.equal(
  (await readFile(compiledBin, 'utf8')).startsWith('#!/usr/bin/env node\n'),
  true,
)

const normal = runBin(compiledBin, ['--version'])
assert.equal(normal.status, 0)
assert.equal(normal.stdout, '0.3.1\n')
assert.equal(normal.stderr, '')

const fixtureRoot = await mkdtemp(join(tmpdir(), 'mutil-e2e-compiled-bin-'))
try {
  const fixtureSource = join(fixtureRoot, 'src')
  await writeFile(join(fixtureRoot, 'package.json'), '{"type":"module"}\n')
  await cp(distSource, fixtureSource, { recursive: true })
  await writeFile(
    join(fixtureSource, 'runtime-bin.js'),
    [
      'export const runRuntimeBin = undefined',
      'throw new Error("secret=canary path=/Users/person/project STACK")',
      '',
    ].join('\n'),
  )

  const failed = runBin(join(fixtureSource, 'bin', 'repo-e2e.js'), ['--version'])
  assert.equal(failed.stdout, '')
  assert.equal(failed.stderr, 'E2E_RUNTIME_INTERNAL_ERROR\n')
  assert.equal(failed.status, 70)
  assert.equal(failed.stderr.includes('canary'), false)
  assert.equal(failed.stderr.includes('/Users/person'), false)
  assert.equal(failed.stderr.includes('STACK'), false)
  assert.equal(failed.stderr.includes('runtime-bin.js'), false)
} finally {
  await rm(fixtureRoot, { force: true, recursive: true })
}

function runBin(entrypoint, arguments_) {
  return spawnSync(process.execPath, [entrypoint, ...arguments_], {
    encoding: 'utf8',
    env: {},
  })
}
