import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'

const packageRules = {
  'e2e-contracts': [],
  'e2e-engine': ['@mutil-skills/e2e-contracts'],
  'e2e-authority': ['@mutil-skills/e2e-contracts'],
  'e2e-gateway': ['@mutil-skills/e2e-contracts'],
  'e2e-playwright-runtime': [
    '@mutil-skills/e2e-authority', '@mutil-skills/e2e-contracts', '@mutil-skills/e2e-engine',
  ],
  'e2e-report': ['@mutil-skills/e2e-contracts'],
} as const

describe('E2E package topology', () => {
  test.each(Object.entries(packageRules))('%s exists with only its allowed internal dependencies', async (directory, allowedDependencies) => {
    const packageJson = JSON.parse(await readFile(join(process.cwd(), 'packages', directory, 'package.json'), 'utf8')) as {
      name?: string
      dependencies?: Record<string, string>
    }
    const internalDependencies = Object.keys(packageJson.dependencies ?? {})
      .filter((dependency) => dependency.startsWith('@mutil-skills/e2e-'))
      .sort()

    expect(packageJson.name).toBe(`@mutil-skills/${directory}`)
    expect(internalDependencies).toEqual([...allowedDependencies].sort())
  })

  test.each(Object.keys(packageRules))('%s exposes a composite TypeScript entrypoint', async (directory) => {
    const packageRoot = join(process.cwd(), 'packages', directory)
    const tsconfig = JSON.parse(await readFile(join(packageRoot, 'tsconfig.json'), 'utf8')) as {
      compilerOptions?: { composite?: boolean }
      include?: string[]
    }
    const entrypoint = await readFile(join(packageRoot, 'src', 'index.ts'), 'utf8')

    expect(tsconfig.compilerOptions?.composite).toBe(true)
    expect(tsconfig.include).toContain('src/**/*.ts')
    expect(entrypoint).toContain('export')
  })

  test('root build, test, and architecture configuration includes every E2E package', async () => {
    const rootTsconfig = JSON.parse(await readFile(join(process.cwd(), 'tsconfig.json'), 'utf8')) as {
      references?: Array<{ path: string }>
    }
    const baseTsconfig = JSON.parse(await readFile(join(process.cwd(), 'tsconfig.base.json'), 'utf8')) as {
      compilerOptions?: { paths?: Record<string, string[]> }
    }
    const vitestConfig = await readFile(join(process.cwd(), 'vitest.config.ts'), 'utf8')
    const architectureCheck = await readFile(join(process.cwd(), 'scripts', 'check-architecture.mjs'), 'utf8')

    for (const directory of Object.keys(packageRules)) {
      const packageName = `@mutil-skills/${directory}`
      expect(rootTsconfig.references?.map((reference) => reference.path)).toContain(`./packages/${directory}`)
      expect(baseTsconfig.compilerOptions?.paths?.[packageName]).toEqual([`packages/${directory}/src/index.ts`])
      expect(vitestConfig).toContain(`'${packageName}':`)
      expect(architectureCheck).toContain(`'${directory}'`)
    }
    expect(rootTsconfig.references?.map((reference) => reference.path)).toContain('./packages/hooks')
  })
})
