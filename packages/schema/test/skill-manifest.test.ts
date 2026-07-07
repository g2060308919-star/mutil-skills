import { describe, expect, test } from 'vitest'
import { parseSkillManifest, validateSkillManifest } from '../src/index.js'

const validManifest = {
  id: 'tdd',
  name: '测试驱动开发',
  source: {
    type: 'github',
    url: 'https://github.com/mattpocock/skills/blob/main/skills/engineering/tdd/SKILL.md',
    rawUrl: 'https://raw.githubusercontent.com/mattpocock/skills/main/skills/engineering/tdd/SKILL.md',
    ref: 'main',
  },
  requires: [
    {
      capability: 'foundation.testing',
      satisfiedBy: ['jest', 'vitest', '@mutil-skills/foundation/testing'],
      whenMissing: {
        action: 'prompt-install',
        package: '@mutil-skills/foundation',
        import: '@mutil-skills/foundation/testing',
      },
    },
  ],
  templateReferences: [{ id: 'foundation.testing.sample-test' }],
}

describe('skill manifest schema', () => {
  test('parses a valid TDD manifest', () => {
    expect(parseSkillManifest(validManifest).requires[0]?.capability).toBe('foundation.testing')
  })

  test('returns structured validation errors for missing required fields', () => {
    const result = validateSkillManifest({ ...validManifest, requires: [{}] })

    expect(result.success).toBe(false)
    expect(result.success === false ? result.errors.some((error) => error.path === 'requires.0.capability') : false).toBe(true)
  })

  test('rejects unsupported capabilities', () => {
    const result = validateSkillManifest({
      ...validManifest,
      requires: [{ ...validManifest.requires[0], capability: 'foundation.database' }],
    })

    expect(result.success).toBe(false)
  })
})
