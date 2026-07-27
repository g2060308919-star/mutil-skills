import { readFile } from 'node:fs/promises'
import { describe, expect, test } from 'vitest'

const packages = ['core', 'schema', 'template', 'foundation', 'skills', 'hooks', 'cli'] as const
const e2ePackages = [
  'e2e-contracts',
  'e2e-engine',
  'e2e-authority',
  'e2e-gateway',
  'e2e-playwright-runtime',
  'e2e-report',
  'e2e-runtime',
] as const

describe('package publishing metadata', () => {
  test.each(packages)('%s package includes build output and excludes tests by files allowlist', async (packageName) => {
    const pkg = JSON.parse(await readFile(new URL(`../packages/${packageName}/package.json`, import.meta.url), 'utf8')) as {
      files?: string[]
      exports?: Record<string, unknown>
    }

    expect(pkg.files).toContain('dist/src')
    expect(pkg.files?.some((entry) => entry.includes('test'))).toBe(false)
  })

  test('schema template and skills packages include required runtime assets', async () => {
    const schema = JSON.parse(await readFile(new URL('../packages/schema/package.json', import.meta.url), 'utf8')) as { files: string[] }
    const template = JSON.parse(await readFile(new URL('../packages/template/package.json', import.meta.url), 'utf8')) as { files: string[] }
    const skills = JSON.parse(await readFile(new URL('../packages/skills/package.json', import.meta.url), 'utf8')) as { files: string[] }

    expect(schema.files).toContain('schemas')
    expect(template.files).toContain('templates')
    expect(skills.files).toContain('skills')
  })

  test('根 package.json 是唯一版本真相，所有 workspace 与内部依赖精确同版', async () => {
    const root = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as {
      version?: string
    }
    expect(root.version).toMatch(/^\d+\.\d+\.\d+$/)

    for (const packageName of [...packages, ...e2ePackages]) {
    const pkg = JSON.parse(await readFile(
      new URL(`../packages/${packageName}/package.json`, import.meta.url),
      'utf8',
    )) as { version?: string; dependencies?: Record<string, string> }

    expect(pkg.version, packageName).toBe(root.version)
    for (const [dependency, version] of Object.entries(pkg.dependencies ?? {})) {
      if (dependency.startsWith('@mutil-skills/')) expect(version, dependency).toBe(root.version)
      expect(version).not.toBe('latest')
      expect(version).not.toMatch(/^workspace:/)
    }
    }
  })

  test('Runtime、README 与 Skill 都指向根版本及同版不可变 Git tag', async () => {
    const [rootText, runtimeProtocol, readme, skill, manifestText] = await Promise.all([
      readFile(new URL('../package.json', import.meta.url), 'utf8'),
      readFile(new URL('../packages/e2e-runtime/src/protocol.ts', import.meta.url), 'utf8'),
      readFile(new URL('../README.md', import.meta.url), 'utf8'),
      readFile(new URL('../packages/skills/skills/testing/e2e/SKILL.md', import.meta.url), 'utf8'),
      readFile(new URL('../packages/skills/skills/testing/e2e/skill.manifest.json', import.meta.url), 'utf8'),
    ])
    const version = (JSON.parse(rootText) as { version: string }).version
    const manifest = JSON.parse(manifestText) as {
      source: { url: string; rawUrl: string; ref: string }
      requires: Array<{ whenMissing: { version: string } }>
    }
    const install = `npm exec --yes --package=@mutil-skills/e2e-runtime@${version} -- repo-e2e install-runtime --version ${version}`

    expect(runtimeProtocol).toContain(`RUNTIME_PACKAGE_VERSION = '${version}'`)
    expect(readme).toContain(install)
    expect(skill).toContain(install)
    expect(manifest.requires[0]?.whenMissing.version).toBe(version)
    expect(manifest.source.ref).toBe(`v${version}`)
    expect(manifest.source.url).toContain(`/blob/v${version}/`)
    expect(manifest.source.rawUrl).toContain(`/v${version}/`)
  })

  test('仓库和全部发布包明确声明 MIT，并声明可实际运行的 Node 下限', async () => {
    const rootLicense = await readFile(new URL('../LICENSE', import.meta.url), 'utf8')
    expect(rootLicense).toContain('MIT License')
    expect(rootLicense).toContain('Copyright (c) 2026')

    for (const packageName of [...packages, ...e2ePackages]) {
      const [manifestText, packageLicense] = await Promise.all([
        readFile(new URL(`../packages/${packageName}/package.json`, import.meta.url), 'utf8'),
        readFile(new URL(`../packages/${packageName}/LICENSE`, import.meta.url), 'utf8'),
      ])
      const pkg = JSON.parse(manifestText) as { license?: string; engines?: { node?: string } }
      expect(pkg.license, packageName).toBe('MIT')
      expect(pkg.engines?.node, packageName).toBe('>=22.13.0')
      expect(packageLicense.trimEnd(), packageName).toBe(rootLicense.trimEnd())
    }
  })

  test('Runtime package 只发布生产入口、审批资产和固定 helper', async () => {
    const runtime = JSON.parse(await readFile(
      new URL('../packages/e2e-runtime/package.json', import.meta.url),
      'utf8',
    )) as { files?: string[]; bin?: Record<string, string> }

    expect(runtime.files).toEqual([
      'dist/src',
      'assets/approval',
      'scripts/authority-child-fchdir.py',
      'scripts/authority-state-openat.py',
      'scripts/gateway-ca-openat.py',
    ])
    expect(runtime.bin).toEqual({ 'repo-e2e': './dist/src/bin/repo-e2e.js' })
  })

  test('Playwright Runtime 的浏览器依赖使用首发精确版本', async () => {
    const runtime = JSON.parse(await readFile(
      new URL('../packages/e2e-playwright-runtime/package.json', import.meta.url),
      'utf8',
    )) as { dependencies?: Record<string, string> }

    expect(runtime.dependencies?.['@playwright/test']).toBe('1.61.1')
    expect(runtime.dependencies?.playwright).toBe('1.61.1')
  })

  test('根验证工具与发布闭包使用同一精确 Playwright 版本', async () => {
    const root = JSON.parse(await readFile(
      new URL('../package.json', import.meta.url),
      'utf8',
    )) as { devDependencies?: Record<string, string> }
    const runtime = JSON.parse(await readFile(
      new URL('../packages/e2e-runtime/package.json', import.meta.url),
      'utf8',
    )) as { dependencies?: Record<string, string> }

    expect(root.devDependencies?.['@playwright/test']).toBe('1.61.1')
    expect(root.devDependencies?.playwright).toBe('1.61.1')
    expect(runtime.dependencies?.playwright).toBe('1.61.1')
  })

  test('正式发布门强制从 npm Registry 验证，不能以本地 tarball 冒充发布成功', async () => {
    const root = JSON.parse(await readFile(
      new URL('../package.json', import.meta.url),
      'utf8',
    )) as { scripts?: Record<string, string> }

    expect(root.scripts?.['verify:e2e-pack']).toBe('node scripts/run-e2e-release.mjs pack')
    expect(root.scripts?.['verify:e2e-release']).toBe('node scripts/run-e2e-release.mjs registry')
    expect(JSON.stringify(root.scripts)).not.toContain('/private/tmp')

    const runner = await readFile(new URL('./run-e2e-release.mjs', import.meta.url), 'utf8')
    expect(runner).toContain("mkdtemp(join(tmpdir(), 'mutil-e2e-release-'))")
    expect(runner).toContain('process.env.E2E_RUNTIME_NPM_CACHE')
    expect(runner).toContain('E2E_RUNTIME_GOLDEN_PACKAGE_SOURCE: \'registry\'')
    expect(runner).toContain("E2E_RUNTIME_RUN_CROSS_REPO: '1'")
    expect(runner).toContain("E2E_RUNTIME_RUN_TODOMVC_PUBLIC: '1'")
    expect(runner).toContain("phase: 'prepublish/workspace-golden'")
    expect(runner).toContain("E2E_RUNTIME_GOLDEN_PACKAGE_SOURCE: 'workspace'")
    expect(runner).toContain('numPendingTests')
    expect(runner).toContain('collectFailures(report)')
  })
})
