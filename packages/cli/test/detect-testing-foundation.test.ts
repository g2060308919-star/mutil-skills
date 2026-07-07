import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { detectTestingFoundation } from '../src/index.js'

async function writePackage(cwd: string, pkg: unknown) {
  await mkdir(cwd, { recursive: true })
  await writeFile(join(cwd, 'package.json'), JSON.stringify(pkg, null, 2))
}

describe('测试基建检测', () => {
  test('detects missing foundation when no scripts dependencies or structure exist', async ({ task }) => {
    const cwd = join(process.cwd(), '.tmp', task.id)
    await writePackage(cwd, { name: 'empty' })

    await expect(detectTestingFoundation(cwd)).resolves.toMatchObject({
      status: 'missing',
      runner: undefined,
      missing: ['scripts', 'dependencies', 'structure'],
    })
  })

  test('detects partial Vitest projects', async ({ task }) => {
    const cwd = join(process.cwd(), '.tmp', task.id)
    await writePackage(cwd, { scripts: { test: 'vitest' } })

    await expect(detectTestingFoundation(cwd)).resolves.toMatchObject({
      status: 'partial',
      runner: 'vitest',
      missing: ['dependencies', 'structure'],
    })
  })

  test('detects partial Jest projects and preserves Jest runner', async ({ task }) => {
    const cwd = join(process.cwd(), '.tmp', task.id)
    await writePackage(cwd, { devDependencies: { jest: '^30.0.0' } })

    await expect(detectTestingFoundation(cwd)).resolves.toMatchObject({
      status: 'partial',
      runner: 'jest',
      missing: ['scripts', 'structure'],
    })
  })

  test('detects complete Vitest projects', async ({ task }) => {
    const cwd = join(process.cwd(), '.tmp', task.id)
    await writePackage(cwd, { scripts: { test: 'vitest run' }, devDependencies: { vitest: '^3.0.0' } })
    await writeFile(join(cwd, 'vitest.config.ts'), 'export default {}')

    await expect(detectTestingFoundation(cwd)).resolves.toMatchObject({
      status: 'complete',
      runner: 'vitest',
      missing: [],
    })
  })

  test('detects conflicted Jest and Vitest projects', async ({ task }) => {
    const cwd = join(process.cwd(), '.tmp', task.id)
    await writePackage(cwd, { scripts: { test: 'vitest' }, devDependencies: { jest: '^30.0.0', vitest: '^3.0.0' } })
    await writeFile(join(cwd, 'jest.config.js'), 'export default {}')
    await writeFile(join(cwd, 'vitest.config.ts'), 'export default {}')

    await expect(detectTestingFoundation(cwd)).resolves.toMatchObject({
      status: 'conflicted',
      runner: undefined,
    })
  })
})
