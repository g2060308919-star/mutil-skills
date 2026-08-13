import { readFile } from 'node:fs/promises'
import { describe, expect, test } from 'vitest'

describe('Full Journey npm command', () => {
  test('显式使用 golden Vitest 配置，不能被默认 exclude 静默排除', async () => {
    const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
    const command = manifest.scripts?.['verify:e2e-full-journey']

    expect(command).toContain('--config vitest.e2e.config.ts')
    expect(command).toContain('scripts/e2e-runtime-cross-repo.golden.test.ts')
  })
})
