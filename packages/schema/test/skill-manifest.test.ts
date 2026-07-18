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

  test('parses fail-closed E2E runtime capabilities', () => {
    const manifest = parseSkillManifest({
      ...validManifest,
      requires: [{
        capability: 'e2e.gateway',
        satisfiedBy: ['@mutil-skills/e2e-gateway'],
        whenMissing: {
          action: 'block', terminalState: 'safety-blocked', reasonCode: 'E2E_GATEWAY_UNAVAILABLE',
        },
      }],
    })

    expect(manifest.requires[0]).toMatchObject({ capability: 'e2e.gateway' })
  })

  test('parses the single installable E2E Runtime Host capability gate', () => {
    const manifest = parseSkillManifest({
      ...validManifest,
      requires: [{
        capability: 'e2e.runtime-host',
        satisfiedBy: [
          '~/.mutil-skills/bin/repo-e2e doctor --json',
          'verified installation manifest + protocol major + safety probes',
        ],
        whenMissing: {
          action: 'prompt-install',
          package: '@mutil-skills/e2e-runtime',
          version: '0.1.0',
          terminalState: 'environment-blocked',
          reasonCode: 'E2E_RUNTIME_HOST_UNAVAILABLE',
        },
      }],
    })

    expect(manifest.requires).toEqual([expect.objectContaining({ capability: 'e2e.runtime-host' })])
  })

  test('rejects widened or inexact E2E Runtime Host installation contracts', () => {
    const runtimeHost = {
      capability: 'e2e.runtime-host',
      satisfiedBy: ['~/.mutil-skills/bin/repo-e2e doctor --json'],
      whenMissing: {
        action: 'prompt-install',
        package: '@mutil-skills/e2e-runtime',
        version: 'latest',
        terminalState: 'environment-blocked',
        reasonCode: 'E2E_RUNTIME_HOST_UNAVAILABLE',
      },
    }

    expect(validateSkillManifest({ ...validManifest, requires: [runtimeHost] }).success).toBe(false)
    expect(validateSkillManifest({
      ...validManifest,
      requires: [{ ...runtimeHost, whenMissing: { ...runtimeHost.whenMissing, version: '0.1.0', extra: true } }],
    }).success).toBe(false)
  })
})
