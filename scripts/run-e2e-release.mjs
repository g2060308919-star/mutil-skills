import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, readFile, realpath, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import {
  classifyReleaseFailures,
  releaseChildEnvironment,
  removeOwnedTemporaryTree,
} from './e2e-release-support.mjs'
import { buildReleaseProof, digestReleaseBytes } from './e2e-release-proof.mjs'

const mode = process.argv[2]
if (mode !== 'pack' && mode !== 'registry' && mode !== 'diagnostic') {
  process.stderr.write('用法：node scripts/run-e2e-release.mjs <pack|registry|diagnostic>\n')
  process.exitCode = 2
} else {
  await run(mode)
}

async function run(releaseMode) {
  const startedAt = new Date().toISOString()
  const sourceRoot = resolve(import.meta.dirname, '..')
  const temporaryRoot = await mkdtemp(join(tmpdir(), 'mutil-e2e-release-'))
  const root = await realpath(temporaryRoot)
  const packs = join(root, 'packs')
  const npmCache = process.env.E2E_RUNTIME_NPM_CACHE === undefined
    ? join(root, 'npm-cache')
    : resolve(process.env.E2E_RUNTIME_NPM_CACHE)
  await Promise.all([
    mkdir(packs, { recursive: true, mode: 0o700 }),
    mkdir(npmCache, { recursive: true, mode: 0o700 }),
  ])
  let completed = false
  let successResult
  let releaseProof
  const phases = []
  const revision = await capture('release/revision', 'git', ['rev-parse', 'HEAD'], sourceRoot)
  const worktreeClean = await capture('release/revision', 'git', ['status', '--porcelain'], sourceRoot) === ''
  try {
    if (releaseMode === 'registry') await verifyReleaseTruth(sourceRoot)
    const npmEnvironment = {
      npm_config_cache: npmCache,
      npm_config_loglevel: 'error',
      npm_config_update_notifier: 'false',
    }
    await runPhase(phases, 'environment/build-clean', async () => await execute('environment/build-clean', process.execPath, [
      join(sourceRoot, 'node_modules', 'typescript', 'bin', 'tsc'),
      '-b',
      '--clean',
    ], sourceRoot, npmEnvironment))
    await runPhase(phases, 'environment/build', async () => await execute(
      'environment/build', 'npm', ['run', 'build'], sourceRoot, npmEnvironment,
    ))
    await runPhase(phases, 'environment/pack', async () => await execute('environment/pack', 'npm', [
      'pack', '--workspaces', '--pack-destination', packs,
    ], sourceRoot, npmEnvironment))

    await runPhase(phases, 'environment/package-closure', async () => await runVitestWithoutSkips({
      phase: 'environment/package-closure',
      sourceRoot,
      reportPath: join(root, 'package-results.json'),
      files: ['scripts/package-metadata.test.ts', 'scripts/e2e-runtime-package.test.ts'],
      env: {
        E2E_RUNTIME_RUN_PACKED_INSTALL: '1',
        E2E_RUNTIME_PACKS_DIR: packs,
        E2E_RUNTIME_NPM_CACHE: npmCache,
        npm_config_cache: npmCache,
      },
    }))

    await runPhase(phases, 'prepublish/workspace-golden', async () => await runVitestWithoutSkips({
      phase: 'prepublish/workspace-golden',
      sourceRoot,
      reportPath: join(root, 'workspace-golden-results.json'),
      files: ['scripts/e2e-runtime-cross-repo.golden.test.ts'],
      config: 'vitest.e2e.config.ts',
      env: releaseMode === 'diagnostic'
        ? diagnosticEnvironment(npmCache)
        : goldenEnvironment('workspace', npmCache),
    }))

    if (releaseMode === 'registry') {
      await runPhase(phases, 'release/registry-golden', async () => await runVitestWithoutSkips({
        phase: 'release/registry-golden',
        sourceRoot,
        reportPath: join(root, 'registry-golden-results.json'),
        files: ['scripts/e2e-runtime-cross-repo.golden.test.ts'],
        config: 'vitest.e2e.config.ts',
        env: goldenEnvironment('registry', npmCache, packs),
      }))
    }
    releaseProof = buildReleaseProof({
      mode: releaseMode === 'registry' ? 'registry' : 'pack', revision, worktreeClean, phases,
      tarballs: await collectTarballProofs(sourceRoot, packs),
      packageClosure: await collectPackageClosure(sourceRoot),
      golden: { workspace: 'passed', registry: releaseMode === 'registry' ? 'passed' : 'not-applicable' },
      skippedTests: 0, hostProof: await readHostProof(), startedAt, finishedAt: new Date().toISOString(),
    })
    await persistReleaseProof(releaseProof)
    if (!releaseProof.conclusion.gateEligible) throw releaseError({
      phase: 'release/proof', code: releaseProof.conclusion.reasonCodes[0] ?? 'E2E_RELEASE_PROOF_INELIGIBLE',
      category: 'environment', remediation: '提供 gateEligible SupportedHostProof 并重新运行正式发布门',
    })
    completed = true
    successResult = {
      ok: true,
      mode: releaseMode,
      skippedTests: 0,
      packageSource: releaseMode === 'registry' ? 'npm-registry' : 'workspace-tarballs',
      ...(releaseMode === 'diagnostic' ? { diagnosticVerdict: 'rejected-as-detected' } : {}),
      releaseProof,
    }
  } catch (error) {
    process.stderr.write(`${JSON.stringify({
      ok: false,
      category: error?.category ?? 'environment',
      phase: error?.phase ?? 'release/unknown',
      code: error?.code ?? 'E2E_RELEASE_GATE_FAILED',
      remediation: error?.remediation ?? '根据 phase 修复环境或 Runtime 后重新执行正式发布门禁',
      failures: error?.failures ?? [],
      ...(releaseProof === undefined ? {} : { releaseProof }),
    })}\n`)
    process.exitCode = 1
  } finally {
    if (process.env.E2E_RELEASE_PRESERVE === '1') {
      process.stderr.write(`E2E_RELEASE_PRESERVED_ROOT:${root}\n`)
    } else {
      await removeOwnedTemporaryTree(root).catch(() => {
        if (completed) {
          completed = false
          process.stderr.write(`${JSON.stringify({
            ok: false,
            category: 'environment',
            phase: 'environment/cleanup',
            code: 'E2E_RELEASE_TEMP_CLEANUP_FAILED',
            remediation: '确认 Runner 自有临时目录可写，并检查 Runtime 安装树是否被外部进程占用',
            failures: [],
          })}\n`)
          process.exitCode = 1
        } else {
          process.stderr.write('E2E_RELEASE_CLEANUP_AFTER_FAILURE_FAILED\n')
        }
      })
    }
    if (!completed) process.stderr.write('正式发布门禁未通过；不得发布或标记 release。\n')
  }
  if (completed) process.stdout.write(`${JSON.stringify(successResult)}\n`)
}

async function runPhase(phases, phase, operation) {
  const startedAt = new Date().toISOString()
  try {
    await operation()
    const finishedAt = new Date().toISOString()
    phases.push({ phase, status: 'passed', startedAt, finishedAt,
      evidenceDigest: digestReleaseBytes(Buffer.from(`${phase}\0${startedAt}\0${finishedAt}\0passed`)) })
  } catch (error) {
    const finishedAt = new Date().toISOString()
    phases.push({ phase, status: 'failed', startedAt, finishedAt,
      evidenceDigest: digestReleaseBytes(Buffer.from(`${phase}\0${startedAt}\0${finishedAt}\0failed`)) })
    throw error
  }
}

async function collectPackageClosure(sourceRoot) {
  const root = JSON.parse(await readFile(join(sourceRoot, 'package.json'), 'utf8'))
  const directories = Array.isArray(root.workspaces) ? root.workspaces : []
  return (await Promise.all(directories.map(async (pattern) => {
    if (!pattern.endsWith('/*')) return []
    const { readdir } = await import('node:fs/promises')
    const parent = join(sourceRoot, pattern.slice(0, -2))
    return await Promise.all((await readdir(parent)).map(async (name) => {
      const manifest = await readFile(join(parent, name, 'package.json'), 'utf8').catch(() => undefined)
      return manifest === undefined ? undefined : JSON.parse(manifest).name
    }))
  }))).flat().filter(Boolean).sort()
}

async function collectTarballProofs(sourceRoot, packs) {
  const closure = await collectPackageClosure(sourceRoot)
  const { readdir } = await import('node:fs/promises')
  const files = await readdir(packs)
  const manifests = await Promise.all(closure.map(async (packageName) => {
    for (const directory of ['packages', '']) {
      const parent = join(sourceRoot, directory)
      const entries = await readdir(parent).catch(() => [])
      for (const entry of entries) {
        const manifest = await readFile(join(parent, entry, 'package.json'), 'utf8').catch(() => undefined)
        if (manifest !== undefined && JSON.parse(manifest).name === packageName) return JSON.parse(manifest)
      }
    }
    return undefined
  }))
  return (await Promise.all(files.filter((file) => file.endsWith('.tgz')).map(async (fileName) => {
    const bytes = await readFile(join(packs, fileName))
    const manifest = manifests.find((candidate) => candidate !== undefined
      && fileName === `${candidate.name.replace(/^@/, '').replaceAll('/', '-')}-${candidate.version}.tgz`)
    return { packageName: manifest?.name ?? fileName, version: manifest?.version ?? '0.0.0',
      fileName, digest: digestReleaseBytes(bytes) }
  }))).sort((left, right) => left.packageName.localeCompare(right.packageName))
}

async function readHostProof() {
  const path = process.env.E2E_SUPPORTED_HOST_PROOF_INPUT
  if (path === undefined) return {
    proofDigest: digestReleaseBytes(Buffer.from('supported-host-proof-missing')), gateEligible: false,
  }
  const proof = JSON.parse(await readFile(resolve(path), 'utf8'))
  return { proofDigest: proof.proofDigest, gateEligible: proof.conclusion?.gateEligible === true }
}

async function persistReleaseProof(proof) {
  if (process.env.E2E_RELEASE_PROOF_OUTPUT !== undefined) {
    const output = resolve(process.env.E2E_RELEASE_PROOF_OUTPUT)
    await mkdir(dirname(output), { recursive: true, mode: 0o700 })
    await writeFile(output, `${JSON.stringify(proof, null, 2)}\n`, { mode: 0o600 })
  }
}

function goldenEnvironment(packageSource, npmCache, packs) {
  return {
    ...(packs === undefined ? {} : { E2E_RUNTIME_RELEASE_PACKS_DIR: packs }),
    E2E_RUNTIME_GOLDEN_PACKAGE_SOURCE: packageSource,
    E2E_RUNTIME_RUN_CROSS_REPO: '1',
    E2E_RUNTIME_NPM_CACHE: npmCache,
  }
}

function diagnosticEnvironment(npmCache) {
  return {
    ...goldenEnvironment('workspace', npmCache),
    E2E_RUNTIME_RUN_TODOMVC_PUBLIC: '1',
    E2E_RUNTIME_TODOMVC_ONLY: '1',
  }
}

async function runVitestWithoutSkips(input) {
  const vitestEntrypoint = join(input.sourceRoot, 'node_modules', 'vitest', 'vitest.mjs')
  const args = [
    vitestEntrypoint, 'run',
    ...(input.config === undefined ? [] : ['--config', input.config]),
    ...input.files,
    '--reporter=json', '--outputFile', input.reportPath,
  ]
  const exitCode = await execute(input.phase, process.execPath, args, input.sourceRoot, input.env, true)
  const report = JSON.parse(await readFile(input.reportPath, 'utf8').catch((cause) => {
    throw releaseError({
      phase: input.phase,
      code: 'E2E_RELEASE_RESULT_MISSING',
      category: 'environment',
      remediation: 'Vitest 未生成结构化结果；检查 Node、Vitest 与临时目录权限',
      cause,
    })
  }))
  if (report.success !== true || report.numFailedTests !== 0 || report.numPendingTests !== 0) {
    const failures = collectFailures(report)
    throw releaseError({
      phase: input.phase,
      code: report.numPendingTests > 0 ? 'E2E_RELEASE_GOLDEN_SKIPPED'
        : exitCode !== 0 ? 'E2E_RELEASE_GOLDEN_FAILED' : 'E2E_RELEASE_RESULT_INVALID',
      category: classifyReleaseFailures(input.phase, failures),
      remediation: report.numPendingTests > 0
        ? '移除或启用全部 skip/conditional test，正式发布门必须是零跳过'
        : '查看对应 JSON test report 中的失败用例与 Runtime reasonCode',
      failures,
    })
  }
}

async function execute(phase, command, args, cwd, extraEnvironment, allowNonZero = false) {
  const code = await new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, {
      cwd,
      shell: false,
      stdio: 'inherit',
      env: releaseChildEnvironment(process.env, extraEnvironment),
    })
    child.once('error', rejectPromise)
    child.once('close', resolvePromise)
  }).catch((cause) => {
    throw releaseError({ phase, code: 'E2E_RELEASE_COMMAND_UNAVAILABLE', category: 'environment', cause })
  })
  if (code !== 0 && !allowNonZero) throw releaseError({
    phase,
    code: 'E2E_RELEASE_COMMAND_FAILED',
    category: 'environment',
  })
  return code
}

function collectFailures(report) {
  return (report.testResults ?? []).flatMap((suite) => [
    ...((suite.status === 'failed' && (suite.message ?? suite.failureMessage)) ? [{
      test: suite.name ?? 'suite setup',
      message: String(suite.message ?? suite.failureMessage).slice(0, 1000),
    }] : []),
    ...(suite.assertionResults ?? []).filter((test) => test.status === 'failed').map((test) => ({
      test: test.fullName ?? test.title ?? 'unknown',
      message: String(test.failureMessages?.[0] ?? '无失败摘要').slice(0, 1000),
    })),
  ]).slice(0, 20)
}

function goldenPhase(phase) {
  return phase.includes('golden')
}

async function verifyReleaseTruth(sourceRoot) {
  const manifest = JSON.parse(await readFile(join(sourceRoot, 'package.json'), 'utf8'))
  const tag = `v${manifest.version}`
  const [status, tagCommit, headCommit, remoteTag] = await Promise.all([
    capture('release/git-truth', 'git', ['status', '--porcelain'], sourceRoot),
    capture('release/tag', 'git', ['rev-list', '-n', '1', tag], sourceRoot),
    capture('release/tag', 'git', ['rev-parse', 'HEAD'], sourceRoot),
    capture('release/tag', 'git', ['ls-remote', '--tags', 'origin', `refs/tags/${tag}^{}`], sourceRoot),
  ])
  const remoteTagCommit = remoteTag.split(/\s+/u)[0] ?? ''
  if (status !== '' || tagCommit !== headCommit || remoteTagCommit !== headCommit) throw releaseError({
    phase: 'release/tag',
    code: status !== '' ? 'E2E_RELEASE_WORKTREE_DIRTY' : 'E2E_RELEASE_TAG_MISMATCH',
    category: 'release-internal',
    remediation: `提交全部发布输入，并创建、推送指向当前提交的不可变 ${tag} 标签后再运行 Registry Golden`,
  })
}

async function capture(phase, command, args, cwd) {
  return await new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, { cwd, shell: false, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.once('error', rejectPromise)
    child.once('close', (code) => code === 0
      ? resolvePromise(stdout.trim())
      : rejectPromise(new Error(`${command} exited ${code}`)))
  }).catch((cause) => {
    throw releaseError({
      phase, code: 'E2E_RELEASE_TAG_UNAVAILABLE', category: 'release-internal', cause,
      remediation: '确认当前提交已有同版本 Git tag 后重试',
    })
  })
}

function releaseError(input) {
  return Object.assign(new Error(input.code, { cause: input.cause }), input)
}
