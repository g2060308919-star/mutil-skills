import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { describe, expect, test, vi } from 'vitest'
import { createSystemSecretProvider, type SecretProviderChild } from '../src/secret-providers.js'

describe('系统 Secret Provider', () => {
  test.each([
    ['macos-keychain', 'darwin', '/usr/bin/security', ['find-generic-password', '-w', '-s', 'mutil-skills-e2e', '-a', 'LOGIN-PASSWORD']],
    ['linux-secret-service', 'linux', '/usr/bin/secret-tool', ['lookup', 'service', 'mutil-skills-e2e', 'account', 'LOGIN-PASSWORD']],
  ] as const)('%s 只执行固定绝对命令且使用最小环境', async (id, platform, executable, expectedArguments) => {
    const calls: unknown[][] = []
    const child = fakeChild()
    const provider = createSystemSecretProvider({
      id,
      platform,
      inspectExecutable: async () => ({ device: '1', inode: '2' }),
      spawn: (command, arguments_, options) => {
        calls.push([command, arguments_, options])
        queueMicrotask(() => { child.stdout.end(Buffer.from('provider-secret-canary\n')); child.emit('close', 0, null) })
        return child
      },
    })
    const value = await provider.resolve('LOGIN-PASSWORD')
    try { expect(value?.toString()).toBe('provider-secret-canary') } finally { value?.fill(0) }
    expect(calls).toEqual([[executable, expectedArguments, {
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { LANG: 'C.UTF-8', PATH: '/usr/bin:/bin' },
    }]])
  })

  test('拒绝可注入 account 并且不会启动命令', async () => {
    const spawn = vi.fn()
    const provider = createSystemSecretProvider({
      id: 'macos-keychain', platform: 'darwin', spawn,
      inspectExecutable: async () => ({ device: '1', inode: '2' }),
    })
    await expect(provider.resolve('--delete-all')).rejects.toThrow(/E2E_SECRET_PROVIDER_INPUT_INVALID/)
    expect(spawn).not.toHaveBeenCalled()
  })

  test('输出超过 64KiB 时 kill 并完全脱敏', async () => {
    const child = fakeChild()
    const provider = createSystemSecretProvider({
      id: 'linux-secret-service', platform: 'linux',
      inspectExecutable: async () => ({ device: '1', inode: '2' }),
      spawn: () => {
        queueMicrotask(() => {
          child.stdout.write(Buffer.alloc(64 * 1024 + 1, 65))
          child.stderr.write(Buffer.from('stderr-super-secret-canary'))
          child.emit('close', null, 'SIGKILL')
        })
        return child
      },
    })
    const error = await provider.resolve('TOKEN').catch((cause: unknown) => cause)
    expect(error).toMatchObject({ code: 'E2E_SECRET_PROVIDER_OUTPUT_LIMIT' })
    expect(child.kill).toHaveBeenCalledWith('SIGKILL')
    expect(String(error)).not.toMatch(/stderr-super-secret-canary|A{100}/)
  })

  test('可执行文件身份在 spawn 后变化时 fail closed 且清空 stdout', async () => {
    const child = fakeChild()
    let inspection = 0
    const provider = createSystemSecretProvider({
      id: 'macos-keychain', platform: 'darwin',
      inspectExecutable: async () => inspection++ === 0
        ? { device: '1', inode: '2' }
        : { device: '1', inode: '3' },
      spawn: () => {
        queueMicrotask(() => { child.stdout.end(Buffer.from('replacement-race-canary')); child.emit('close', 0, null) })
        return child
      },
    })
    await expect(provider.resolve('TOKEN')).rejects.toMatchObject({ code: 'E2E_SECRET_PROVIDER_EXECUTABLE_REPLACED' })
  })

  test('平台与 provider 不匹配或系统路径不存在时稳定阻塞', async () => {
    expect(() => createSystemSecretProvider({ id: 'macos-keychain', platform: 'linux' }))
      .toThrow(/E2E_SECRET_PROVIDER_PLATFORM_MISMATCH/)
    const provider = createSystemSecretProvider({
      id: 'linux-secret-service', platform: 'linux',
      inspectExecutable: async () => { throw new Error('/usr/bin/secret-tool missing canary') },
    })
    const error = await provider.resolve('TOKEN').catch((cause: unknown) => cause)
    expect(error).toMatchObject({ code: 'E2E_SECRET_PROVIDER_EXECUTABLE_INVALID' })
    expect(String(error)).not.toContain('missing canary')
  })

  test('spawn error、signal 和非零退出只返回脱敏稳定错误', async () => {
    for (const outcome of ['error', 'signal', 'exit'] as const) {
      const child = fakeChild()
      const provider = createSystemSecretProvider({
        id: 'macos-keychain', platform: 'darwin',
        inspectExecutable: async () => ({ device: '1', inode: '2' }),
        spawn: () => {
          queueMicrotask(() => {
            child.stderr.write('credential-canary')
            if (outcome === 'error') child.emit('error', new Error('credential-canary'))
            else child.emit('close', outcome === 'exit' ? 44 : null, outcome === 'signal' ? 'SIGTERM' : null)
          })
          return child
        },
      })
      const error = await provider.resolve('TOKEN').catch((cause: unknown) => cause)
      expect(error).toMatchObject({ code: 'E2E_SECRET_PROVIDER_UNAVAILABLE' })
      expect(String(error)).not.toContain('credential-canary')
    }
  })

  test('超时会 SIGKILL 并返回稳定脱敏错误', async () => {
    const child = fakeChild()
    const provider = createSystemSecretProvider({
      id: 'macos-keychain', platform: 'darwin', timeoutMs: 1,
      inspectExecutable: async () => ({ device: '1', inode: '2' }),
      spawn: () => child,
    })
    await expect(provider.resolve('TOKEN')).rejects.toMatchObject({ code: 'E2E_SECRET_PROVIDER_TIMEOUT' })
    expect(child.kill).toHaveBeenCalledWith('SIGKILL')
  })

  test('stdout/stderr stream error 也会 kill、脱敏并稳定收敛', async () => {
    for (const streamName of ['stdout', 'stderr'] as const) {
      const child = fakeChild()
      const provider = createSystemSecretProvider({
        id: 'macos-keychain', platform: 'darwin',
        inspectExecutable: async () => ({ device: '1', inode: '2' }),
        spawn: () => {
          queueMicrotask(() => child[streamName].emit('error', new Error('stream-secret-canary')))
          return child
        },
      })
      const error = await provider.resolve('TOKEN').catch((cause: unknown) => cause)
      expect(error).toMatchObject({ code: 'E2E_SECRET_PROVIDER_UNAVAILABLE' })
      expect(String(error)).not.toContain('stream-secret-canary')
      expect(child.kill).toHaveBeenCalledWith('SIGKILL')
    }
  })
})

function fakeChild(): SecretProviderChild & {
  stdout: PassThrough
  stderr: PassThrough
  kill: ReturnType<typeof vi.fn>
} {
  const child = new EventEmitter() as SecretProviderChild & {
    stdout: PassThrough
    stderr: PassThrough
    kill: ReturnType<typeof vi.fn>
  }
  child.stdout = new PassThrough()
  child.stderr = new PassThrough()
  child.kill = vi.fn(() => true)
  return child
}
