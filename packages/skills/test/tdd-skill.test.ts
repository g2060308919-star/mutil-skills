import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { existsSync } from 'node:fs'
import { describe, expect, test } from 'vitest'
import { parseSkillManifest } from '../../schema/src/index.js'
import { listSkills, resolveSkill, resolveSkillDirectory } from '../src/index.js'

describe('TDD skill package', () => {
  test('registry exposes the standalone TDD skill files', () => {
    const skill = resolveSkill('tdd')

    expect(skill?.id).toBe('tdd')
    expect(skill?.files.map((file) => file.name).sort()).toEqual(['README.md', 'SKILL.md', 'mocking.md', 'skill.manifest.json', 'tests.md'])
    expect(listSkills().map((item) => item.id)).toContain('tdd')
    expect(resolveSkillDirectory('tdd')).toMatch(/skills\/engineering\/tdd$/)
    expect(existsSync(resolveSkillDirectory('tdd') ?? '')).toBe(true)
  })

  test('TDD manifest 通过 schema 校验并声明测试基建能力', async () => {
    const manifestText = await readFile(new URL('../skills/engineering/tdd/skill.manifest.json', import.meta.url), 'utf8')
    const manifest = parseSkillManifest(JSON.parse(manifestText))

    expect(manifest.requires[0]).toMatchObject({
      capability: 'foundation.testing',
      satisfiedBy: ['jest', 'vitest', '@mutil-skills/foundation/testing'],
    })
  })

  test('TDD manifest schema path resolves to the schema package file', async () => {
    const manifestPath = new URL('../skills/engineering/tdd/skill.manifest.json', import.meta.url)
    const manifestText = await readFile(manifestPath, 'utf8')
    const manifest = JSON.parse(manifestText) as { $schema: string }
    const resolvedSchemaPath = resolve(dirname(manifestPath.pathname), manifest.$schema)

    expect(resolvedSchemaPath).toMatch(/packages\/schema\/schemas\/skill\.manifest\.schema\.json$/)
    expect(existsSync(resolvedSchemaPath)).toBe(true)
  })

  test('SKILL.md contains the clearly marked standalone preflight instructions', async () => {
    const skill = await readFile(new URL('../skills/engineering/tdd/SKILL.md', import.meta.url), 'utf8')

    expect(skill).toContain('Mutil Skills 独立安装测试基建预检')
    expect(skill).toContain('@mutil-skills/foundation')
    expect(skill).toContain('用户确认计划前，不要安装依赖或写入文件')
    expect(skill).toContain('目标项目中存在 `CONTEXT.md`')
    expect(skill).toContain('[tests.md](tests.md)')
    expect(skill).toContain('[mocking.md](mocking.md)')
    expect(skill).toContain('不在目标项目生成 `vitest.config.ts`')
    expect(skill).not.toContain('独立 Codex skill')
  })

  test('README explains standalone packaging and manifest behavior without host-specific wording', async () => {
    const readme = await readFile(new URL('../skills/engineering/tdd/README.md', import.meta.url), 'utf8')

    expect(readme).toContain('skill.manifest.json')
    expect(readme).toContain('独立')
    expect(readme).toContain('tests.md')
    expect(readme).toContain('mocking.md')
    expect(readme).toContain('host runtime')
    expect(readme).not.toContain('Codex')
  })

  test('TDD reference files are present for standalone installation', async () => {
    const tests = await readFile(new URL('../skills/engineering/tdd/tests.md', import.meta.url), 'utf8')
    const mocking = await readFile(new URL('../skills/engineering/tdd/mocking.md', import.meta.url), 'utf8')

    expect(tests).toContain('好测试')
    expect(tests).toContain('同义反复')
    expect(mocking).toContain('什么时候 mock')
    expect(mocking).toContain('系统边界')
  })

  test('skills source does not import runtime packages from cli foundation or template', async () => {
    const registry = await readFile(new URL('../src/registry.ts', import.meta.url), 'utf8')

    expect(registry).not.toMatch(/@mutil-skills\/(cli|foundation|template)/)
  })
})
