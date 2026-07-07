import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

export interface SkillRegistryEntry {
  id: string
  name: string
  relativePath: string
  files: Array<{ name: 'SKILL.md' | 'skill.manifest.json' | 'README.md' | 'tests.md' | 'mocking.md'; relativePath: string }>
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

export function listSkills(): SkillRegistryEntry[] {
  return [tddSkill]
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
