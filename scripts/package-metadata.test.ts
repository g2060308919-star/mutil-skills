import { readFile } from 'node:fs/promises'
import { describe, expect, test } from 'vitest'

const packages = ['core', 'schema', 'template', 'foundation', 'skills', 'hooks', 'cli'] as const

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
})
