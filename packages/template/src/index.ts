export interface TemplateDefinition {
  id: string
  description: string
  render: (values: Record<string, unknown>) => string
}

export const templates: TemplateDefinition[] = [
  {
    id: 'foundation.testing.vitest-config',
    description: 'foundation testing baseline 的默认 Vitest 配置。',
    render(values) {
      const environment = stringValue(values.environment, 'node')
      const include = arrayValue(values.include, ['**/*.test.ts', '**/*.test.tsx', '**/*.spec.ts', '**/*.spec.tsx'])
      return [
        "import { defineConfig } from 'vitest/config'",
        '',
        'export default defineConfig({',
        '  test: {',
        `    environment: '${environment}',`,
        `    include: [${include.map((pattern) => `'${pattern}'`).join(', ')}],`,
        '  },',
        '})',
        '',
      ].join('\n')
    },
  },
  {
    id: 'foundation.testing.sample-test',
    description: '用于证明生成的 foundation 可运行的样例测试。',
    render(values) {
      const packageName = stringValue(values.packageName, 'project')
      return [
        "import { describe, expect, test } from 'vitest'",
        '',
        `describe('${packageName} 测试基建', () => {`,
        "  test('可以运行生成的 baseline', () => {",
        '    expect(true).toBe(true)',
        '  })',
        '})',
        '',
      ].join('\n')
    },
  },
  {
    id: 'foundation.testing.package-scripts',
    description: 'repo-test 接入推荐的 package scripts。',
    render() {
      return `${JSON.stringify({ test: 'repo-test', 'test:watch': 'repo-test --watch' }, null, 2)}\n`
    },
  },
]

export function getTemplate(id: string): TemplateDefinition | undefined {
  return templates.find((template) => template.id === id)
}

export function renderTemplate(id: string, values: Record<string, unknown> = {}): string {
  const template = getTemplate(id)
  if (!template) {
    throw new Error(`未知 template：${id}`)
  }
  return template.render(values)
}

function stringValue(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.length > 0 ? value : fallback
}

function arrayValue(value: unknown, fallback: string[]): string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string') ? value : fallback
}
