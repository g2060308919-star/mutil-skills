import { access, chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import {
  classifyReleaseFailures,
  releaseChildEnvironment,
  removeOwnedTemporaryTree,
} from './e2e-release-support.mjs'

describe('E2E release failure classification', () => {
  test('Runner 自有临时根包含只读 Runtime 安装树时仍完成清理', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mutil-release-cleanup-test-'))
    const hardened = join(root, 'home', '.mutil-skills', 'runtime', 'e2e', 'versions', '0.6.0')
    await mkdir(hardened, { recursive: true, mode: 0o700 })
    await writeFile(join(hardened, 'manifest.json'), '{}\n', { mode: 0o400 })
    await chmod(hardened, 0o500)

    try {
      await removeOwnedTemporaryTree(root)
      await expect(access(root)).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      await chmod(hardened, 0o700).catch(() => undefined)
      await rm(root, { recursive: true, force: true })
    }
  })

  test('将 Node、Chrome、Gateway 与临时目录问题归为 Runtime 环境失败', () => {
    expect(classifyReleaseFailures('release/registry-golden', [{
      test: 'fresh HOME',
      message: 'E2E_GATEWAY_PATH_UNAVAILABLE',
    }])).toBe('environment')
    expect(classifyReleaseFailures('release/registry-golden', [{
      test: 'gateway policy', message: 'E2E_GATEWAY_REQUEST_OUT_OF_ORDER',
    }])).toBe('safety')
    expect(classifyReleaseFailures('release/registry-golden', [{
      test: 'gateway loopback', message: 'E2E_GATEWAY_LOOPBACK_UNAVAILABLE',
    }])).toBe('environment')
    for (const code of ['E2E_GATEWAY_CHILD_EXITED', 'E2E_GATEWAY_CA_HELPER_FAILED']) {
      expect(classifyReleaseFailures('release/registry-golden', [{
        test: 'gateway unexpected', message: code,
      }])).toBe('release-internal')
    }
    expect(classifyReleaseFailures('release/registry-golden', [{
      test: 'browser',
      message: 'Chrome executable ENOENT',
    }])).toBe('environment')
  })

  test('将 Oracle 断言不满足归为业务失败', () => {
    expect(classifyReleaseFailures('release/registry-golden', [{
      test: 'checkout oracle',
      message: 'E2E_RELEASE_BUSINESS:expected rejected to be accepted',
    }])).toBe('business')
  })

  test('将加载器或测试框架损坏归为发布门内部失败', () => {
    expect(classifyReleaseFailures('release/registry-golden', [{
      test: 'suite setup',
      message: 'Cannot find module vitest',
    }])).toBe('release-internal')
    expect(classifyReleaseFailures('environment/package-closure', [])).toBe('environment')
    expect(classifyReleaseFailures('release/registry-golden', [{
      test: 'unknown assertion', message: 'expected false to be true',
    }])).toBe('release-internal')
  })

  test('正式门清除调用方 diagnostic 控制变量，只允许当前模式显式恢复', () => {
    const inherited = {
      HOME: '/safe/home',
      E2E_RUNTIME_RUN_TODOMVC_PUBLIC: '1',
      E2E_RUNTIME_TODOMVC_ONLY: '1',
    }
    expect(releaseChildEnvironment(inherited, { E2E_RUNTIME_RUN_CROSS_REPO: '1' })).toEqual({
      HOME: '/safe/home', E2E_RUNTIME_RUN_CROSS_REPO: '1',
    })
    expect(releaseChildEnvironment(inherited, {
      E2E_RUNTIME_RUN_TODOMVC_PUBLIC: '1', E2E_RUNTIME_TODOMVC_ONLY: '1',
    })).toMatchObject({
      E2E_RUNTIME_RUN_TODOMVC_PUBLIC: '1', E2E_RUNTIME_TODOMVC_ONLY: '1',
    })
  })
})
