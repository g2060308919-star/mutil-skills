import { readFile } from 'node:fs/promises'
import { describe, expect, test } from 'vitest'

describe('npm Trusted Publishing workflow', () => {
  test('Linux 运行全量验证，macOS 运行系统 Chrome Golden 与发布闭环', async () => {
    const workflow = await readFile(new URL('../.github/workflows/publish.yml', import.meta.url), 'utf8')

    const linuxJob = workflow.indexOf('verify-linux:')
    const publishJob = workflow.indexOf('publish:')
    expect(linuxJob).toBeGreaterThan(0)
    expect(publishJob).toBeGreaterThan(linuxJob)

    const linux = workflow.slice(linuxJob, publishJob)
    expect(linux).toContain('runs-on: ubuntu-latest')
    expect(linux).toContain('run: npm test')
    expect(linux).not.toContain('npm run verify:e2e-pack')
    expect(linux).not.toContain('npm-trusted-publishing.mjs')

    const publish = workflow.slice(publishJob)
    expect(publish).toContain('needs: verify-linux')
    expect(publish).toContain('runs-on: macos-14')
    const workspaceGolden = publish.indexOf('run: npm run verify:e2e-pack')
    const registryPublish = publish.indexOf('run: node scripts/npm-trusted-publishing.mjs')
    const registryGolden = publish.indexOf('run: npm run verify:e2e-release')
    expect(workspaceGolden).toBeGreaterThan(0)
    expect(registryPublish).toBeGreaterThan(workspaceGolden)
    expect(registryGolden).toBeGreaterThan(registryPublish)
  })
})
