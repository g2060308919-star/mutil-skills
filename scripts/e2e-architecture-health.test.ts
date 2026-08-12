import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { analyzeArchitectureHealth } from './e2e-architecture-health.mjs'

describe('机器可读架构健康报告', () => {
  test('发现 package cycle、第二状态决策者和 test capability 泄漏，但不按文件行数失败', async () => {
    const root = await mkdtemp(join(tmpdir(), 'e2e-arch-health-'))
    await packageFixture(root, 'a', ['b'], 'export const a = 1\n')
    await packageFixture(root, 'b', ['a'], 'export const createTestBrowserCapability = () => ({})\n')
    await mkdir(join(root, 'packages/e2e-shadow-controller/src'), { recursive: true })
    await writeFile(join(root, 'packages/e2e-shadow-controller/package.json'), JSON.stringify({ name: 'shadow' }))
    await writeFile(join(root, 'packages/e2e-shadow-controller/src/index.ts'),
      `${'// large but harmless\n'.repeat(2_000)}export function transitionWorkflow() { return 'accepted' }\n`)

    const report = await analyzeArchitectureHealth(root)
    expect(report.gate.passed).toBe(false)
    expect(report.findings.map((item) => item.code)).toEqual(expect.arrayContaining([
      'E2E_ARCH_PACKAGE_CYCLE', 'E2E_ARCH_SECOND_STATE_AUTHORITY', 'E2E_ARCH_TEST_CAPABILITY_EXPORTED',
    ]))
    expect(report.findings.map((item) => item.code)).not.toContain('E2E_ARCH_FILE_TOO_LARGE')
  })
})

async function packageFixture(root: string, name: string, dependencies: string[], source: string) {
  const packageRoot = join(root, `packages/${name}`)
  await mkdir(join(packageRoot, 'src'), { recursive: true })
  await writeFile(join(packageRoot, 'package.json'), JSON.stringify({ name, dependencies: Object.fromEntries(
    dependencies.map((dependency) => [dependency, '1.0.0'])) }))
  await writeFile(join(packageRoot, 'src/index.ts'), source)
}
