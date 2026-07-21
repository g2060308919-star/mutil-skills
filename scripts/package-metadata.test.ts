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

  test.each(e2ePackages)('%s 使用 0.2.1 且内部依赖全部精确同版', async (packageName) => {
    const pkg = JSON.parse(await readFile(
      new URL(`../packages/${packageName}/package.json`, import.meta.url),
      'utf8',
    )) as { version?: string; dependencies?: Record<string, string> }

    expect(pkg.version).toBe('0.2.1')
    for (const [dependency, version] of Object.entries(pkg.dependencies ?? {})) {
      if (dependency.startsWith('@mutil-skills/e2e-')) expect(version, dependency).toBe('0.2.1')
      expect(version).not.toBe('latest')
      expect(version).not.toMatch(/^workspace:/)
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
})
