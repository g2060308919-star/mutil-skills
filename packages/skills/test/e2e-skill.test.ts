import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { describe, expect, test } from 'vitest'
import { parseSkillManifest } from '../../schema/src/index.js'
import { listSkills, resolveSkill, resolveSkillDirectory } from '../src/index.js'

const workflowFiles = [
  'prd-intake.md',
  'acceptance-scope.md',
  'requirement-model.md',
  'interaction-flow.md',
  'coverage-cases.md',
  'execution-contract.md',
  'browser-verification.md',
  'automation-healing.md',
  'regression-assets.md',
  'visual-report.md',
  'artifact-protocol.md',
]

describe('E2E skill package', () => {
  test('registry exposes the E2E skill and its bundled workflow files', () => {
    const skill = resolveSkill('e2e')

    expect(skill?.id).toBe('e2e')
    expect(skill?.relativePath).toBe('skills/testing/e2e')
    expect(skill?.files.map((file) => file.name)).toEqual([
      'SKILL.md',
      'skill.manifest.json',
      'prd-intake.md',
      'acceptance-scope.md',
      'requirement-model.md',
      'interaction-flow.md',
      'coverage-cases.md',
      'execution-contract.md',
      'browser-verification.md',
      'automation-healing.md',
      'regression-assets.md',
      'visual-report.md',
      'artifact-protocol.md',
    ])
    expect(existsSync(resolveSkillDirectory('e2e') ?? '')).toBe(true)
  })

  test('E2E manifest validates without runtime prerequisites', async () => {
    const manifestText = await readFile(new URL('../skills/testing/e2e/skill.manifest.json', import.meta.url), 'utf8')
    const manifest = parseSkillManifest(JSON.parse(manifestText))

    expect(manifest).toMatchObject({
      id: 'e2e',
      name: 'PRD 驱动 E2E 浏览器验收',
      requires: [],
      source: {
        url: 'https://github.com/g2060308919-star/mutil-skills/blob/main/packages/skills/skills/testing/e2e/SKILL.md',
        rawUrl: 'https://raw.githubusercontent.com/g2060308919-star/mutil-skills/main/packages/skills/skills/testing/e2e/SKILL.md',
      },
    })
  })

  test.each(workflowFiles)('%s defines a standalone execution contract', async (file) => {
    const text = await readFile(new URL(`../skills/testing/e2e/${file}`, import.meta.url), 'utf8')

    for (const heading of [
      '## 目的',
      '## 触发条件',
      '## 必需输入',
      '## 可选输入',
      '## 工作流',
      '## 详细算法',
      '## 输出',
      '## 完成条件',
      '## 阻塞条件',
      '## 禁止行为',
      '## 独立使用示例',
    ]) {
      expect(text).toContain(heading)
    }
  })

  test('entrypoint enforces confirmations and non-negotiable browser safety', async () => {
    const text = await readFile(new URL('../skills/testing/e2e/SKILL.md', import.meta.url), 'utf8')

    expect(text).toContain('[acceptance-scope.md](acceptance-scope.md)')
    expect(text).toContain('[execution-contract.md](execution-contract.md)')
    expect(text).toContain('未完成验收范围确认')
    expect(text).toContain('未完成执行契约确认')
    expect(text).toContain('生产环境默认只读')
    expect(text).toContain('不得通过弱化断言')
  })

  test('E2E workflow files stay local and preserve the TDD skill', () => {
    expect(listSkills().map((skill) => skill.id)).toEqual(['tdd', 'e2e'])
    expect(resolveSkill('tdd')?.files.map((file) => file.name)).toContain('tests.md')
    expect(resolveSkill('e2e')?.files.every((file) => file.relativePath.startsWith('skills/testing/e2e/'))).toBe(true)
  })
})
