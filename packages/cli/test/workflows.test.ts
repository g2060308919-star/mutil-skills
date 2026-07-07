import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { describe, expect, test, vi } from 'vitest'
import { applyBootstrapPlan, buildBootstrapPlan, formatBootstrapPlan, repoTddWorkflow, repoTest, resolveRepoTddSkillDirectory } from '../src/index.js'

describe('CLI workflows', () => {
  test('repo-test delegates to foundation testing runner', async () => {
    const runTests = vi.fn(async () => ({ runner: 'vitest' as const, exitCode: 0 }))

    await expect(repoTest({ cwd: '/project', args: ['--watch', '--coverage', '--', '--runInBand'], runTests })).resolves.toEqual({ runner: 'vitest', exitCode: 0 })
    expect(runTests).toHaveBeenCalledWith({ cwd: '/project', watch: true, coverage: true, args: ['--runInBand'] })
  })

  test('bootstrap plan for missing foundation proposes confirmed project changes', () => {
    expect(buildBootstrapPlan({
      status: 'missing',
      runner: undefined,
      evidence: [],
      missing: ['scripts', 'dependencies', 'structure'],
    })).toEqual({
      status: 'missing',
      runner: 'vitest',
      missing: ['scripts', 'dependencies', 'structure'],
      packages: ['@mutil-skills/foundation'],
      files: ['package.json', 'tests/foundation.sample.test.ts'],
      scripts: { test: 'repo-test', 'test:watch': 'repo-test --watch' },
      requiresConfirmation: true,
      summary: '安装 @mutil-skills/foundation 并接入默认测试基建 baseline。',
    })
  })

  test('formatted bootstrap plan contains state missing pieces packages files scripts and refusal guidance', () => {
    const message = formatBootstrapPlan(buildBootstrapPlan({
      status: 'missing',
      runner: undefined,
      evidence: [],
      missing: ['scripts', 'dependencies', 'structure'],
    }))

    expect(message).toContain('状态：missing')
    expect(message).toContain('缺失项：scripts, dependencies, structure')
    expect(message).toContain('准备安装的包：@mutil-skills/foundation')
    expect(message).toContain('准备写入或修改的文件：package.json, tests/foundation.sample.test.ts')
    expect(message).not.toContain('vitest.config.ts')
    expect(message).toContain('准备增加的 scripts：test=repo-test, test:watch=repo-test --watch')
    expect(message).toContain('如果拒绝')
  })

  test('bootstrap plan for partial Jest preserves Jest and fills missing dependency script and structure', () => {
    expect(buildBootstrapPlan({
      status: 'partial',
      runner: 'jest',
      evidence: ['script:test=jest'],
      missing: ['dependencies', 'structure'],
    })).toEqual({
      status: 'partial',
      runner: 'jest',
      missing: ['dependencies', 'structure'],
      packages: ['jest'],
      files: ['jest.config.js', 'tests/foundation.sample.test.ts'],
      scripts: {},
      requiresConfirmation: true,
      summary: '补齐现有 Jest 测试基建，不迁移到 Vitest。',
    })
  })

  test('confirmed foundation bootstrap replaces npm init placeholder test script', async ({ task }) => {
    const cwd = join(process.cwd(), '.tmp', `${task.id}-${randomUUID()}`)
    await mkdir(cwd, { recursive: true })
    await writeFile(join(cwd, 'package.json'), JSON.stringify({
      name: 'consumer',
      scripts: {
        test: 'echo "Error: no test specified" && exit 1',
      },
    }, null, 2))

    await applyBootstrapPlan(cwd, buildBootstrapPlan({
      status: 'missing',
      runner: undefined,
      evidence: [],
      missing: ['scripts', 'dependencies', 'structure'],
    }), async () => undefined)

    const pkg = JSON.parse(await readFile(join(cwd, 'package.json'), 'utf8')) as { scripts: Record<string, string> }
    expect(pkg.scripts).toMatchObject({
      test: 'repo-test',
      'test:watch': 'repo-test --watch',
    })
  })

  test('repo-tdd stops before modifying files when manifest is invalid', async ({ task }) => {
    const cwd = join(process.cwd(), '.tmp', `${task.id}-${randomUUID()}`)
    const skillDir = join(cwd, 'skill')
    await mkdir(skillDir, { recursive: true })
    await writeFile(join(skillDir, 'SKILL.md'), '# TDD')
    await writeFile(join(skillDir, 'skill.manifest.json'), JSON.stringify({ id: 'tdd' }))

    await expect(repoTddWorkflow({ cwd, skillDir })).rejects.toThrow(/skill manifest 无效/)
  })

  test('repo-tdd resolves packaged TDD skill directory for default and explicit skill args', () => {
    expect(resolveRepoTddSkillDirectory([])).toMatch(/skills\/engineering\/tdd$/)
    expect(resolveRepoTddSkillDirectory(['--skill', 'tdd'])).toMatch(/skills\/engineering\/tdd$/)
  })

  test('repo-tdd does not modify missing-foundation projects when user rejects bootstrap', async ({ task }) => {
    const cwd = join(process.cwd(), '.tmp', `${task.id}-${randomUUID()}`)
    const skillDir = join(cwd, 'skill')
    await mkdir(skillDir, { recursive: true })
    await writeFile(join(cwd, 'package.json'), JSON.stringify({ name: 'consumer' }, null, 2))
    await writeFile(join(skillDir, 'SKILL.md'), '# TDD')
    await writeFile(join(skillDir, 'skill.manifest.json'), JSON.stringify({
      id: 'tdd',
      name: '测试驱动开发',
      source: { type: 'github', url: 'https://example.test', rawUrl: 'https://example.test/raw', ref: 'main' },
      requires: [{ capability: 'foundation.testing', satisfiedBy: ['jest', 'vitest', '@mutil-skills/foundation/testing'], whenMissing: { action: 'prompt-install', package: '@mutil-skills/foundation', import: '@mutil-skills/foundation/testing' } }],
      templateReferences: [],
    }, null, 2))

    const result = await repoTddWorkflow({ cwd, skillDir, confirm: async () => false })

    expect(result.status).toBe('cancelled')
    expect(await readFile(join(cwd, 'package.json'), 'utf8')).toContain('"name": "consumer"')
  })

  test('repo-tdd reads SKILL.md and installs package before generating confirmed foundation baseline without Vitest config', async ({ task }) => {
    const cwd = join(process.cwd(), '.tmp', `${task.id}-${randomUUID()}`)
    const skillDir = join(cwd, 'skill')
    const installPackage = vi.fn(async () => undefined)
    const runTests = vi.fn(async () => ({ runner: 'vitest' as const, exitCode: 0 }))
    await mkdir(skillDir, { recursive: true })
    await writeFile(join(cwd, 'package.json'), JSON.stringify({ name: 'consumer' }, null, 2))
    await writeFile(join(skillDir, 'SKILL.md'), '# TDD')
    await writeFile(join(skillDir, 'skill.manifest.json'), JSON.stringify({
      id: 'tdd',
      name: '测试驱动开发',
      source: { type: 'github', url: 'https://example.test', rawUrl: 'https://example.test/raw', ref: 'main' },
      requires: [{ capability: 'foundation.testing', satisfiedBy: ['jest', 'vitest', '@mutil-skills/foundation/testing'], whenMissing: { action: 'prompt-install', package: '@mutil-skills/foundation', import: '@mutil-skills/foundation/testing' } }],
      templateReferences: [],
    }, null, 2))

    const result = await repoTddWorkflow({ cwd, skillDir, confirm: async () => true, installPackage, runTests })

    expect(result.status).toBe('ready')
    expect(installPackage).toHaveBeenCalledWith('@mutil-skills/foundation', cwd)
    expect(runTests).toHaveBeenCalledWith({ cwd, passWithNoTests: true })
    await expect(readFile(join(cwd, 'vitest.config.ts'), 'utf8')).rejects.toThrow()
    expect(await readFile(join(cwd, 'tests', 'foundation.sample.test.ts'), 'utf8')).toContain('可以运行')
  })
})
