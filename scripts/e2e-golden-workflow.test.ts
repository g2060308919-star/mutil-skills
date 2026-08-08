import { readFile } from 'node:fs/promises'
import { describe, expect, test } from 'vitest'

describe('非发布型 E2E Golden workflow', () => {
  test('PR 和手动触发只运行 macOS pack Golden，绝不获得发布权限', async () => {
    const workflow = await readFile(
      new URL('../.github/workflows/e2e-golden.yml', import.meta.url),
      'utf8',
    )

    expect(workflow).toContain('pull_request:')
    expect(workflow).toContain('workflow_dispatch:')
    expect(workflow).toContain('branches: [master]')
    expect(workflow).toContain('permissions:\n  contents: read')
    expect(workflow).toContain('runs-on: macos-14')
    expect(workflow).toContain("node-version: '24'")
    expect(workflow).toContain('run: npm ci')
    expect(workflow).toContain('run: npm run verify:e2e-pack')

    for (const forbidden of [
      'pull_request_target:',
      'id-token: write',
      'npm-trusted-publishing',
      'npm publish',
      'verify:e2e-release',
      'tags:',
      'secrets.',
    ]) {
      expect(workflow, forbidden).not.toContain(forbidden)
    }
  })
})
