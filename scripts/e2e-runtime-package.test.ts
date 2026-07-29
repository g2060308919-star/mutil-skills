import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { afterEach, describe, expect, test } from 'vitest'
import { ArtifactSchemaRegistry, WriteApprovalSubjectV2Schema, digestText }
  from '@mutil-skills/e2e-contracts'
import { runtimeFullPlaywrightFixture, runtimeGoldenPrdText, runtimeReadOnlyFixture }
  from './e2e-runtime-read-only.fixture.js'
import { runWithTransientNpmRetry } from './npm-transient-retry.js'

const execFileAsync = promisify(execFile)
const releaseVersion = (JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as {
  version: string
}).version
const temporaryRoots: string[] = []
const runPackedInstall = process.env.E2E_RUNTIME_RUN_PACKED_INSTALL === '1'
const packedArtifactsDirectory = process.env.E2E_RUNTIME_PACKS_DIR
const publishedPackages = [
  '@mutil-skills/e2e-contracts',
  '@mutil-skills/e2e-engine',
  '@mutil-skills/e2e-authority',
  '@mutil-skills/e2e-gateway',
  '@mutil-skills/e2e-playwright-runtime',
  '@mutil-skills/e2e-report',
  '@mutil-skills/e2e-runtime',
] as const
const requiredFiles = [
  'dist/src/bin/repo-e2e.js',
  'dist/src/launcher-template.js',
  'assets/approval/index.html',
  'assets/approval/approval.js',
  'assets/approval/simplewebauthn-browser.js',
  'assets/approval/simplewebauthn-LICENSE.md',
  'scripts/authority-child-fchdir.py',
  'scripts/authority-state-openat.py',
  'scripts/gateway-ca-openat.py',
]

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('E2E Runtime npm tarball', () => {
  test('跨仓 child 只从已安装 Runtime 闭包加载 E2E 包，并在启动前清空项目依赖', async () => {
    const [child, driver] = await Promise.all([
      readFile(new URL('./e2e-runtime-cross-repo-child.mjs', import.meta.url), 'utf8'),
      readFile(new URL('./e2e-runtime-cross-repo.ts', import.meta.url), 'utf8'),
    ])
    expect(child).not.toMatch(/from ['"]@mutil-skills\//)
    expect(child).toContain("installedPackage('e2e-authority')")
    expect(child).toContain("installedPackage('e2e-contracts')")
    expect(child).not.toContain('runCli(')
    expect(child).toContain("join(homeDir, '.mutil-skills', 'bin', 'repo-e2e')")
    expect(child).toContain("spawn(launcher, ['rpc']")
    expect(child).toContain('manifestDocument.signatures.length !== 0')
    expect(child).not.toContain('artifactAuthority.verifyArtifactSignature(signature, expectedManifestDigest)')
    expect(child).toContain('createTrustedCompilerExecutionTrust({')
    expect(child).toContain('discoveryAuthority: {')
    expect(child).toContain('runBrowserPreflight({')
    expect(child).toContain("approvalType: 'discovery'")
    expect(child).toContain('projectGatewayRules({')
    expect(child).toContain("freshSnapshot.trustedExecutionFacts['signed-discovery-grant'] = freshPreflight.grant")
    expect(child).toContain("freshSnapshot.trustedExecutionFacts['browser-preflight'] = freshPreflight.fact")
    expect(child).toContain('approvalFreshnessClient: artifactAuthority.createTrustedApprovalFreshnessClient()')
    expect(child).toContain("'manifest' in browserInstallation")
    expect(child).toContain('browserInstallation.selection.source.executablePath')
    expect(child).toContain('const bridgeSnapshot = readBridge.snapshot()')
    expect(child).toContain('compilerExecutionDiagnostic(execution)')
    expect(child).toContain('activeApprovalContext = structuredClone(input.grant.approvalContext)')
    expect(child).toContain('{ approvalContext: activeApprovalContext }')
    expect(driver).toContain("rm(join(input.project, 'node_modules')")
    expect(driver).toContain("rm(join(input.project, 'package.json')")
    expect(driver).toContain('const harnessRoot = join(root, \'harness\')')
    expect(driver).toContain("['.git', '.worktrees', '.superpowers', '.tmp', 'node_modules']")
  })

  test('跨仓 fixture 的全部外部资产都符合当前严格 schema', () => {
    const fixture = runtimeReadOnlyFixture({
      runId: 'RUN-CROSS-REPO', assetId: 'ASSET-CROSS-REPO',
      prdRevision: digestText('test/v1', 'prd'), installationDigest: digestText('test/v1', 'runtime'),
      url: 'http://fixture.test/orders', now: new Date('2026-07-18T00:00:00.000Z'),
    })
    for (const artifact of [
      ...Object.values(fixture.semanticArtifacts), ...Object.values(fixture.frozenArtifacts),
      fixture.regressionManifest,
    ]) {
      const parsed = ArtifactSchemaRegistry[artifact.artifactType].safeParse(artifact)
      expect(parsed.success, `${artifact.artifactType}:${parsed.success ? '' : parsed.error.message}`).toBe(true)
    }
    const executionContract = fixture.frozenArtifacts['execution-contract'].content as {
      identities: Array<{ roleIds: string[]; secretRef: string }>
    }
    expect(executionContract.identities).toEqual([
      { identityId: 'IDENTITY-AUDITOR', roleIds: ['auditor'], secretRef: 'SECRET-REF-LOCAL' },
    ])
  })

  test('跨仓 full-playwright fixture 冻结表单、Popup、多页面、JSON 写、Cleanup 与 Reload', () => {
    const fixture = runtimeFullPlaywrightFixture({
      runId: 'RUN-FULL-CROSS-REPO', assetId: 'ASSET-FULL-CROSS-REPO',
      prdRevision: digestText('test/v1', 'full-prd'),
      installationDigest: digestText('test/v1', 'runtime'),
      url: 'http://fixture.test/', now: new Date('2026-07-23T00:00:00.000Z'),
    })
    for (const document of [
      ...Object.values(fixture.semanticArtifacts), ...Object.values(fixture.frozenArtifacts),
      fixture.regressionManifest,
    ]) {
      const parsed = ArtifactSchemaRegistry[document.artifactType].safeParse(document)
      expect(parsed.success, `${document.artifactType}:${parsed.success ? '' : parsed.error.message}`).toBe(true)
      expect(document.artifactId).toBe(`ARTIFACT-${document.artifactType.toUpperCase()}`)
    }
    const subject = WriteApprovalSubjectV2Schema.parse(fixture.writeSubject(
      'DISCOVERY-FULL-1', digestText('test/v1', 'preflight'),
    ))
    expect(subject.actions[0]).toMatchObject({
      operation: 'full-playwright', dataLeaseId: 'LEASE-FULL-1', fencingToken: 1,
    })
    const program = (fixture.frozenArtifacts['execution-contract'].content as any)
      .fullPlaywrightPrograms[0]
    expect(program.source).toContain("getByLabel('Name').fill('Ada')")
    expect(program.source).toContain("waitForEvent('page')")
    expect(program.source).toContain('browser.newContext()')
    expect(program.networkRequestBodies).toEqual([
      { intentId: 'API', kind: 'json', canonicalJson: '{"enabled":true,"name":"Ada"}' },
    ])
    expect(program.cleanupSource).toContain("request.post('http://fixture.test/reset')")
    expect(program.cleanupSource).toContain('page.reload()')
    expect(program.cleanupSource).toContain("locator('#state')")
    const automatedCaseIds = (fixture.semanticArtifacts['coverage-universe'].content as any)
      .obligations.flatMap((obligation: any) => obligation.disposition.kind === 'automated'
        ? obligation.disposition.caseIds : [])
    const activeCaseIds = (fixture.frozenArtifacts['test-cases'].content as any)
      .cases.filter((testCase: any) => testCase.status === 'active')
      .map((testCase: any) => testCase.caseId)
    expect(automatedCaseIds).toEqual(activeCaseIds)
    const executionRoles = (fixture.frozenArtifacts['execution-contract'].content as any)
      .identities.flatMap((identity: any) => identity.roleIds)
    const scheduledActors = (fixture.frozenArtifacts['test-cases'].content as any)
      .cases.filter((testCase: any) => activeCaseIds.includes(testCase.caseId))
      .map((testCase: any) => testCase.actor)
    expect(executionRoles).toEqual(scheduledActors)
  })

  test('跨仓订单 Clause 必须逐字回切共享 PRD 来源', () => {
    const fixture = runtimeReadOnlyFixture({
      runId: 'RUN-SOURCE-CLOSURE', assetId: 'ASSET-SOURCE-CLOSURE',
      prdRevision: digestText('test/v1', runtimeGoldenPrdText), installationDigest: digestText('test/v1', 'runtime'),
      url: 'http://fixture.test/orders', now: new Date('2026-07-18T00:00:00.000Z'),
    })
    const manifest = fixture.semanticArtifacts['prd-manifest'].content as {
      sources: Array<{ sourceId: string }>
      clauses: Array<{
        sourceId: string
        sourceSpan: { startLine: number; startColumn: number; endLine: number; endColumn: number }
        originalText: string
      }>
    }
    const clause = manifest.clauses[0]!
    const lines = runtimeGoldenPrdText.replace(/\r\n?/g, '\n').split('\n')
    const actual = lines[clause.sourceSpan.startLine - 1]!
      .slice(clause.sourceSpan.startColumn - 1, clause.sourceSpan.endColumn - 1)

    expect(manifest.sources).toContainEqual(expect.objectContaining({ sourceId: 'PRD-BODY' }))
    expect(clause.sourceId).toBe('PRD-BODY')
    expect(actual).toBe(clause.originalText)
  })

  test('allowlist 包含 launcher、审批资产与 helper，并排除测试、原始证据和环境文件', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mutil-e2e-runtime-pack-'))
    temporaryRoots.push(root)
    const sourceManifest = JSON.parse(await readFile(
      new URL('../packages/e2e-runtime/package.json', import.meta.url),
      'utf8',
    )) as Record<string, unknown>
    await writeFile(join(root, 'package.json'), `${JSON.stringify({
      ...sourceManifest,
      scripts: {},
      dependencies: {},
    }, null, 2)}\n`)

    for (const file of requiredFiles) {
      const path = join(root, file)
      await mkdir(dirname(path), { recursive: true })
      await writeFile(path, file.endsWith('.py') ? '#!/usr/bin/python3\n' : 'production asset\n')
    }
    for (const file of ['test/fixture.js', 'raw-evidence/session.json', '.env', 'assets/private.pem',
      'scripts/copy-approval-assets.mjs']) {
      const path = join(root, file)
      await mkdir(dirname(path), { recursive: true })
      await writeFile(path, 'must not ship\n')
    }

    const { stdout } = await execFileAsync('npm', ['pack', '--json', '--dry-run', '--ignore-scripts'], {
      cwd: root,
      env: { ...process.env, npm_config_cache: join(root, '.npm-cache') },
    })
    const result = JSON.parse(stdout) as Array<{ files: Array<{ path: string }> }>
    const files = result[0]?.files.map((entry) => entry.path).sort() ?? []

    expect(files).toEqual(expect.arrayContaining(requiredFiles))
    expect(files.some((file) => /(?:^|\/)(?:test|raw-evidence)(?:\/|$)/.test(file))).toBe(false)
    expect(files.some((file) => /(?:^|\/)\.env$/.test(file))).toBe(false)
    expect(files.some((file) => /\.(?:pem|key|crt)$/.test(file))).toBe(false)
    expect(files).not.toContain('package/scripts/copy-approval-assets.mjs')
    expect(files).toContain('assets/approval/simplewebauthn-LICENSE.md')
  }, 30_000)

  test('仓库中的 Runtime 生产资产与 helper 均真实存在', async () => {
    for (const file of requiredFiles) {
      await expect(readFile(new URL(`../packages/e2e-runtime/${file}`, import.meta.url)))
        .resolves.toBeInstanceOf(Buffer)
    }
  })

  test.skipIf(!runPackedInstall)(
    '在空白目录仅从七个本地 tarball 安装、导入并执行 Runtime bin',
    async () => {
      if (packedArtifactsDirectory === undefined) {
        throw new Error('E2E_RUNTIME_RUN_PACKED_INSTALL=1 时必须提供 E2E_RUNTIME_PACKS_DIR')
      }
      const root = await mkdtemp(join(tmpdir(), 'mutil-e2e-runtime-packed-install-'))
      temporaryRoots.push(root)
      const project = join(root, 'blank-project')
      const home = join(root, 'home')
      // HOME/项目必须全新；npm cache 只保存公共内容寻址 tarball，可由发布门显式复用，
      // 避免冷网络把 Runtime 环境失败误判成业务失败。
      const npmCache = process.env.E2E_RUNTIME_NPM_CACHE ?? join(root, 'npm-cache')
      await Promise.all([
        mkdir(project, { recursive: true, mode: 0o700 }),
        mkdir(home, { recursive: true, mode: 0o700 }),
        mkdir(npmCache, { recursive: true, mode: 0o700 }),
      ])
      await writeFile(join(project, 'package.json'), `${JSON.stringify({
        name: 'runtime-packed-install-smoke', private: true, version: '0.0.0', type: 'module',
      }, null, 2)}\n`)

      const tarballs = await resolvePackageTarballs(packedArtifactsDirectory)
      await runWithTransientNpmRetry(() => execFileAsync(
        'npm',
        [
          'install', '--ignore-scripts', '--omit=dev', '--no-bin-links', '--no-audit', '--no-fund', '--save-exact',
          ...tarballs,
        ],
        {
          cwd: project,
          env: packedInstallEnvironment({ home, npmCache }),
          timeout: 780_000,
          maxBuffer: 10 * 1024 * 1024,
        },
      ), {
        maxAttempts: 2,
      })

      const sourceRoot = await realpath(new URL('..', import.meta.url).pathname)
      for (const packageName of publishedPackages) {
        const packageRoot = join(project, 'node_modules', ...packageName.split('/'))
        const manifest = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8')) as {
          name?: unknown
          version?: unknown
        }
        expect(manifest).toMatchObject({ name: packageName, version: releaseVersion })
        const loaded = await import(pathToFileURL(join(packageRoot, 'dist', 'src', 'index.js')).href)
        expect(loaded).toBeTypeOf('object')
        expect(await realpath(packageRoot)).not.toContain(sourceRoot)
      }

      const runtimeBin = join(project, 'node_modules', '@mutil-skills', 'e2e-runtime',
        'dist', 'src', 'bin', 'repo-e2e.js')
      const commandEnvironment = packedRuntimeEnvironment({ home })
      const version = await execFileAsync(process.execPath, [runtimeBin, '--version'], {
        cwd: project, env: commandEnvironment, timeout: 30_000,
      })
      expect(version.stdout.trim()).toBe(releaseVersion)
      expect(`${version.stdout}${version.stderr}`).not.toContain(sourceRoot)

      await expect(execFileAsync(process.execPath, [runtimeBin, 'doctor', '--json'], {
        cwd: project, env: commandEnvironment, timeout: 30_000,
      })).rejects.toMatchObject({
        code: 3,
        stdout: expect.stringContaining('"ready":false'),
      })
    },
    840_000,
  )
})

async function resolvePackageTarballs(directory: string): Promise<string[]> {
  const root = await realpath(resolve(directory))
  const files = await readdir(root)
  return publishedPackages.map((packageName) => {
    const expectedPrefix = packageName.replace('@mutil-skills/', 'mutil-skills-').replaceAll('/', '-')
    const matches = files.filter((file) => file === `${expectedPrefix}-${releaseVersion}.tgz`)
    if (matches.length !== 1) {
      throw new Error(`打包目录中 ${packageName}@${releaseVersion} 的 tarball 数量必须为 1`)
    }
    return join(root, matches[0]!)
  })
}

function packedInstallEnvironment(input: { home: string; npmCache: string }): NodeJS.ProcessEnv {
  return {
    HOME: input.home,
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    TMPDIR: process.env.TMPDIR ?? tmpdir(),
    npm_config_cache: input.npmCache,
  }
}

function packedRuntimeEnvironment(input: { home: string }): NodeJS.ProcessEnv {
  return {
    HOME: input.home,
    PATH: '/usr/bin:/bin',
    TMPDIR: process.env.TMPDIR ?? tmpdir(),
  }
}
