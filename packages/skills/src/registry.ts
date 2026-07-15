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
    { name: 'scope-approval.md', relativePath: 'skills/testing/e2e/scope-approval.md' },
    { name: 'requirement-oracles.md', relativePath: 'skills/testing/e2e/requirement-oracles.md' },
    { name: 'coverage-universe.md', relativePath: 'skills/testing/e2e/coverage-universe.md' },
    { name: 'execution-approval.md', relativePath: 'skills/testing/e2e/execution-approval.md' },
    { name: 'data-and-cleanup.md', relativePath: 'skills/testing/e2e/data-and-cleanup.md' },
    { name: 'browser-preflight-binding.md', relativePath: 'skills/testing/e2e/browser-preflight-binding.md' },
    { name: 'safety-gateway.md', relativePath: 'skills/testing/e2e/safety-gateway.md' },
    { name: 'browser-execution.md', relativePath: 'skills/testing/e2e/browser-execution.md' },
    { name: 'diagnosis-healing.md', relativePath: 'skills/testing/e2e/diagnosis-healing.md' },
    { name: 'evidence-privacy.md', relativePath: 'skills/testing/e2e/evidence-privacy.md' },
    { name: 'regression-publication.md', relativePath: 'skills/testing/e2e/regression-publication.md' },
    { name: 'report-verdict.md', relativePath: 'skills/testing/e2e/report-verdict.md' },
    { name: 'artifact-transaction.md', relativePath: 'skills/testing/e2e/artifact-transaction.md' },
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
