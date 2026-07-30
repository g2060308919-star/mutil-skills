import { describe, expect, test } from 'vitest'
import {
  assertTrustedPublishingEnvironment,
  decideRegistryPublication,
  topologicalReleaseOrder,
} from './npm-trusted-publishing.mjs'

describe('npm Trusted Publishing release helper', () => {
  test('只允许 GitHub Actions 的精确版本 Tag 发布', () => {
    expect(() => assertTrustedPublishingEnvironment('0.4.1', {
      GITHUB_ACTIONS: 'true',
      GITHUB_REF_TYPE: 'tag',
      GITHUB_REF_NAME: 'v0.4.1',
    })).not.toThrow()

    expect(() => assertTrustedPublishingEnvironment('0.4.1', {
      GITHUB_ACTIONS: 'true',
      GITHUB_REF_TYPE: 'branch',
      GITHUB_REF_NAME: 'feat-initial',
    })).toThrow('只允许 Git Tag')
    expect(() => assertTrustedPublishingEnvironment('0.4.1', {
      GITHUB_ACTIONS: 'true',
      GITHUB_REF_TYPE: 'tag',
      GITHUB_REF_NAME: 'v0.4.2',
    })).toThrow('必须与根版本一致')
    expect(() => assertTrustedPublishingEnvironment('0.4.1', {})).toThrow('只能在 GitHub Actions')
  })

  test('按照内部依赖拓扑发布全部同版 workspace', () => {
    const manifests = [
      { name: '@mutil-skills/runtime', version: '0.4.1', dependencies: { '@mutil-skills/engine': '0.4.1' } },
      { name: '@mutil-skills/contracts', version: '0.4.1', dependencies: {} },
      { name: '@mutil-skills/engine', version: '0.4.1', dependencies: { '@mutil-skills/contracts': '0.4.1' } },
    ]

    expect(topologicalReleaseOrder(manifests, '0.4.1').map((item) => item.name)).toEqual([
      '@mutil-skills/contracts',
      '@mutil-skills/engine',
      '@mutil-skills/runtime',
    ])
  })

  test('拒绝内部依赖漂移和依赖环', () => {
    expect(() => topologicalReleaseOrder([
      { name: '@mutil-skills/a', version: '0.4.1', dependencies: { '@mutil-skills/b': '0.4.0' } },
      { name: '@mutil-skills/b', version: '0.4.1', dependencies: {} },
    ], '0.4.1')).toThrow('内部依赖版本')

    expect(() => topologicalReleaseOrder([
      { name: '@mutil-skills/a', version: '0.4.1', dependencies: { '@mutil-skills/b': '0.4.1' } },
      { name: '@mutil-skills/b', version: '0.4.1', dependencies: { '@mutil-skills/a': '0.4.1' } },
    ], '0.4.1')).toThrow('依赖环')
  })

  test('仅跳过 Registry 中内容完整性完全相同的已发布包', () => {
    expect(decideRegistryPublication('sha512-local', undefined)).toBe('publish')
    expect(decideRegistryPublication('sha512-same', 'sha512-same')).toBe('skip')
    expect(() => decideRegistryPublication('sha512-local', 'sha512-other')).toThrow('完整性冲突')
  })
})
