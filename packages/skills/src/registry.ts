import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

export interface SkillRegistryEntry {
  id: string
  name: string
  relativePath: string
  files: Array<{ name: string; relativePath: string }>
}

const tddSkill: SkillRegistryEntry = {
  id: 'tdd',
  name: '测试驱动开发',
  relativePath: 'skills/engineering/tdd',
  files: [
    { name: 'SKILL.md', relativePath: 'skills/engineering/tdd/SKILL.md' },
    { name: 'skill.manifest.json', relativePath: 'skills/engineering/tdd/skill.manifest.json' },
    { name: 'README.md', relativePath: 'skills/engineering/tdd/README.md' },
    { name: 'tests.md', relativePath: 'skills/engineering/tdd/tests.md' },
    { name: 'mocking.md', relativePath: 'skills/engineering/tdd/mocking.md' },
  ],
}

const e2eSkill: SkillRegistryEntry = {
  id: 'e2e',
  name: 'PRD 驱动 E2E 浏览器验收',
  relativePath: 'skills/testing/e2e',
  files: [
    { name: 'SKILL.md', relativePath: 'skills/testing/e2e/SKILL.md' },
    { name: 'skill.manifest.json', relativePath: 'skills/testing/e2e/skill.manifest.json' },
    { name: 'prd-intake.md', relativePath: 'skills/testing/e2e/prd-intake.md' },
    { name: 'acceptance-scope.md', relativePath: 'skills/testing/e2e/acceptance-scope.md' },
    { name: 'requirement-model.md', relativePath: 'skills/testing/e2e/requirement-model.md' },
    { name: 'interaction-flow.md', relativePath: 'skills/testing/e2e/interaction-flow.md' },
    { name: 'coverage-cases.md', relativePath: 'skills/testing/e2e/coverage-cases.md' },
    { name: 'execution-contract.md', relativePath: 'skills/testing/e2e/execution-contract.md' },
    { name: 'browser-verification.md', relativePath: 'skills/testing/e2e/browser-verification.md' },
    { name: 'automation-healing.md', relativePath: 'skills/testing/e2e/automation-healing.md' },
    { name: 'regression-assets.md', relativePath: 'skills/testing/e2e/regression-assets.md' },
    { name: 'visual-report.md', relativePath: 'skills/testing/e2e/visual-report.md' },
    { name: 'artifact-protocol.md', relativePath: 'skills/testing/e2e/artifact-protocol.md' },
  ],
}

export function listSkills(): SkillRegistryEntry[] {
  return [tddSkill, e2eSkill]
}

export function resolveSkill(id: string): SkillRegistryEntry | undefined {
  return listSkills().find((skill) => skill.id === id)
}

export function resolveSkillDirectory(id: string): string | undefined {
  const skill = resolveSkill(id)
  if (!skill) return undefined

  for (const relativePrefix of ['../', '../../']) {
    const candidate = fileURLToPath(new URL(`${relativePrefix}${skill.relativePath}`, import.meta.url))
    if (existsSync(candidate)) {
      return candidate
    }
  }

  return fileURLToPath(new URL(`../${skill.relativePath}`, import.meta.url))
}
