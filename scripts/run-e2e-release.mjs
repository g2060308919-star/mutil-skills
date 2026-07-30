import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, readFile, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { classifyReleaseFailures, releaseChildEnvironment } from './e2e-release-support.mjs'

const mode = process.argv[2]
if (mode !== 'pack' && mode !== 'registry' && mode !== 'diagnostic') {
  process.stderr.write('用法：node scripts/run-e2e-release.mjs <pack|registry|diagnostic>\n')
  process.exitCode = 2
} else {
  await run(mode)
}

async function run(releaseMode) {
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
  try {
    if (releaseMode === 'registry') await verifyReleaseTruth(sourceRoot)
    const npmEnvironment = {
      npm_config_cache: npmCache,
      npm_config_loglevel: 'error',
      npm_config_update_notifier: 'false',
    }
    await execute('environment/build', 'npm', ['run', 'build'], sourceRoot, npmEnvironment)
    await execute('environment/pack', 'npm', [
      'pack', '--workspaces', '--pack-destination', packs,
    ], sourceRoot, npmEnvironment)

    await runVitestWithoutSkips({
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
    })

    await runVitestWithoutSkips({
      phase: 'prepublish/workspace-golden',
      sourceRoot,
      reportPath: join(root, 'workspace-golden-results.json'),
      files: ['scripts/e2e-runtime-cross-repo.golden.test.ts'],
      config: 'vitest.e2e.config.ts',
      env: releaseMode === 'diagnostic'
        ? diagnosticEnvironment(npmCache)
        : goldenEnvironment('workspace', npmCache),
    })

    if (releaseMode === 'registry') {
      await runVitestWithoutSkips({
        phase: 'release/registry-golden',
        sourceRoot,
        reportPath: join(root, 'registry-golden-results.json'),
        files: ['scripts/e2e-runtime-cross-repo.golden.test.ts'],
        config: 'vitest.e2e.config.ts',
        env: goldenEnvironment('registry', npmCache, packs),
      })
    }
    completed = true
    process.stdout.write(`${JSON.stringify({
      ok: true,
      mode: releaseMode,
      skippedTests: 0,
      packageSource: releaseMode === 'registry' ? 'npm-registry' : 'workspace-tarballs',
      ...(releaseMode === 'diagnostic' ? { diagnosticVerdict: 'rejected-as-detected' } : {}),
    })}\n`)
  } catch (error) {
    process.stderr.write(`${JSON.stringify({
      ok: false,
      category: error?.category ?? 'environment',
      phase: error?.phase ?? 'release/unknown',
      code: error?.code ?? 'E2E_RELEASE_GATE_FAILED',
      remediation: error?.remediation ?? '根据 phase 修复环境或 Runtime 后重新执行正式发布门禁',
      failures: error?.failures ?? [],
    })}\n`)
    process.exitCode = 1
  } finally {
    if (process.env.E2E_RELEASE_PRESERVE === '1') {
      process.stderr.write(`E2E_RELEASE_PRESERVED_ROOT:${root}\n`)
    } else {
      await rm(root, { recursive: true, force: true })
    }
    if (!completed) process.stderr.write('正式发布门禁未通过；不得发布或标记 release。\n')
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
