import { describe, expect, test } from 'vitest'
import { getTemplate, renderTemplate } from '../src/index.js'

describe('foundation testing templates', () => {
  test('renders the default Vitest config template', async () => {
    const output = await renderTemplate('foundation.testing.vitest-config', {
      environment: 'node',
      include: ['src/**/*.test.ts'],
    })

    expect(output).toContain("environment: 'node'")
    expect(output).toContain("'src/**/*.test.ts'")
  })

  test('renders the sample test template', async () => {
    expect(renderTemplate('foundation.testing.sample-test', { packageName: 'demo' })).toContain("describe('demo 测试基建'")
  })

  test('exposes template metadata by declarative id', () => {
    expect(getTemplate('foundation.testing.package-scripts')?.id).toBe('foundation.testing.package-scripts')
  })
})
