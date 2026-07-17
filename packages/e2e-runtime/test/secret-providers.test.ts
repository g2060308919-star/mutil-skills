import { EventEmitter } from 'node:events'
import { spawn as spawnChild } from 'node:child_process'
import { PassThrough } from 'node:stream'
import { describe, expect, test, vi } from 'vitest'
import { E2EError } from '@mutil-skills/e2e-contracts'
import {
  createDefaultSystemSecretProviders,
  createSystemSecretProvider,
  type SecretProviderChild,
} from '../src/secret-providers.js'

describe('系统 Secret Provider', () => {
  test('生产默认只按宿主平台装配单一系统 provider，未知平台不回退 env', () => {
    expect(createDefaultSystemSecretProviders('darwin').map(({ id }) => id)).toEqual(['macos-keychain'])
    expect(createDefaultSystemSecretProviders('linux').map(({ id }) => id)).toEqual(['linux-secret-service'])
    expect(createDefaultSystemSecretProviders('win32').map(({ id }) => id)).toEqual([])
  })

  test.each([
    ['macos-keychain', 'darwin', '/usr/bin/security', ['find-generic-password', '-w', '-s', 'mutil-skills-e2e', '-a', 'LOGIN-PASSWORD']],
    ['linux-secret-service', 'linux', '/usr/bin/secret-tool', ['lookup', 'service', 'mutil-skills-e2e', 'account', 'LOGIN-PASSWORD']],
  ] as const)('%s 只执行固定绝对命令且使用最小环境', async (id, platform, executable, expectedArguments) => {
    const calls: unknown[][] = []
    const child = fakeChild()
    const provider = createSystemSecretProvider({
      id,
      platform,
      ...(platform === 'linux' ? {
        uid: 501,
        inspectLinuxSessionBus: async () => trustedLinuxBus(501),
      } : {}),
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
      env: platform === 'linux'
        ? {
          LANG: 'C.UTF-8', PATH: '/usr/bin:/bin',
          XDG_RUNTIME_DIR: '/run/user/501',
          DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/501/bus',
        }
        : { LANG: 'C.UTF-8', PATH: '/usr/bin:/bin' },
    }]])
  })

  test('Linux provider 只使用严格验证后的固定 session bus 环境，不继承宿主环境', async () => {
    const child = fakeChild()
    let actualOptions: unknown
    const spawn = vi.fn((_command: string, _arguments: string[], options: unknown) => {
      actualOptions = options
      queueMicrotask(() => { child.stdout.end('secret\n'); child.emit('close', 0, null) })
      return child
    })
    const inspectLinuxSessionBus = vi.fn(async () => trustedLinuxBus(501))
    const provider = createSystemSecretProvider({
      id: 'linux-secret-service', platform: 'linux', uid: 501,
      inspectExecutable: async () => ({ device: '1', inode: '2' }),
      inspectLinuxSessionBus, spawn,
    })
    const value = await provider.resolve('TOKEN')
    value?.fill(0)
    expect(inspectLinuxSessionBus).toHaveBeenCalledTimes(2)
    expect(inspectLinuxSessionBus).toHaveBeenLastCalledWith(501)
    expect(actualOptions).toEqual({
      shell: false, stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        LANG: 'C.UTF-8', PATH: '/usr/bin:/bin',
        XDG_RUNTIME_DIR: '/run/user/501',
        DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/501/bus',
      },
    })
    expect((actualOptions as { env: object }).env).not.toHaveProperty('HOME')
  })

  test('Linux session bus 不可验证时在 spawn 前 fail closed', async () => {
    const spawn = vi.fn()
    const provider = createSystemSecretProvider({
      id: 'linux-secret-service', platform: 'linux', uid: 501, spawn,
      inspectExecutable: async () => ({ device: '1', inode: '2' }),
      inspectLinuxSessionBus: async () => { throw new Error('host-path-canary') },
    })
    const error = await provider.resolve('TOKEN').catch((cause: unknown) => cause)
    expect(error).toMatchObject({ code: 'E2E_SECRET_PROVIDER_SESSION_BUS_INVALID' })
    expect(String(error)).not.toContain('host-path-canary')
    expect(spawn).not.toHaveBeenCalled()
  })

  test('Linux session bus 在 spawn 边界被替换时 SIGKILL 并 fail closed', async () => {
    const child = fakeChild()
    let inspection = 0
    const provider = createSystemSecretProvider({
      id: 'linux-secret-service', platform: 'linux', uid: 501,
      inspectExecutable: async () => ({ device: '1', inode: '2' }),
      inspectLinuxSessionBus: async () => ({
        ...trustedLinuxBus(501), socketInode: inspection++ === 0 ? '3' : '4',
      }),
      spawn: () => child,
    })
    await expect(provider.resolve('TOKEN')).rejects.toMatchObject({
      code: 'E2E_SECRET_PROVIDER_SESSION_BUS_REPLACED',
    })
    expect(child.kill).toHaveBeenCalledWith('SIGKILL')
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
      id: 'linux-secret-service', platform: 'linux', uid: 501,
      inspectLinuxSessionBus: async () => trustedLinuxBus(501),
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

  test('child 已成功 fulfilled 后 post-spawn 复验失败仍清零所有已产出的明文 Buffer', async () => {
    const child = fakeChild()
    const canary = Buffer.from('fulfilled-postcheck-secret')
    const captured: Buffer[] = []
    const originalFrom = Buffer.from
    const fromSpy = vi.spyOn(Buffer, 'from').mockImplementation(((...arguments_: unknown[]) => {
      const result = Reflect.apply(originalFrom, Buffer, arguments_) as Buffer
      if (result.toString('utf8') === 'fulfilled-postcheck-secret') captured.push(result)
      return result
    }) as typeof Buffer.from)
    let inspection = 0
    let releasePostcheck!: () => void
    const postcheck = new Promise<void>((resolve) => { releasePostcheck = resolve })
    const provider = createSystemSecretProvider({
      id: 'macos-keychain', platform: 'darwin',
      inspectExecutable: async () => {
        if (inspection++ === 0) return { device: '1', inode: '2' }
        await postcheck
        return { device: '1', inode: '3' }
      },
      spawn: () => {
        queueMicrotask(() => {
          child.stdout.end(canary)
          child.emit('close', 0, null)
          queueMicrotask(releasePostcheck)
        })
        return child
      },
    })
    try {
      await expect(provider.resolve('TOKEN')).rejects.toMatchObject({
        code: 'E2E_SECRET_PROVIDER_EXECUTABLE_REPLACED',
      })
      expect(captured.length).toBeGreaterThan(0)
      for (const plaintext of captured) {
        expect([...plaintext]).toEqual(new Array(plaintext.length).fill(0))
      }
    } finally {
      fromSpy.mockRestore()
      canary.fill(0)
      for (const plaintext of captured) plaintext.fill(0)
    }
  })

  test('post-spawn inspector 抛 E2EError 也统一 abort，并清零已 fulfilled 明文', async () => {
    const child = fakeChild()
    const canary = Buffer.from('inspector-e2eerror-secret')
    const captured: Buffer[] = []
    const originalFrom = Buffer.from
    const fromSpy = vi.spyOn(Buffer, 'from').mockImplementation(((...arguments_: unknown[]) => {
      const result = Reflect.apply(originalFrom, Buffer, arguments_) as Buffer
      if (result.toString('utf8') === 'inspector-e2eerror-secret') captured.push(result)
      return result
    }) as typeof Buffer.from)
    let inspection = 0
    let releasePostcheck!: () => void
    const postcheck = new Promise<void>((resolve) => { releasePostcheck = resolve })
    let closed = false
    const provider = createSystemSecretProvider({
      id: 'macos-keychain', platform: 'darwin',
      inspectExecutable: async () => {
        if (inspection++ === 0) return { device: '1', inode: '2' }
        await postcheck
        throw new E2EError({
          code: 'E2E_INSPECTOR_INTERNAL_CANARY', category: 'safety',
          message: 'inspector must not escape', retryable: false,
        })
      },
      spawn: () => {
        queueMicrotask(() => {
          child.stdout.end(canary)
          closed = true
          child.emit('close', 0, null)
          queueMicrotask(releasePostcheck)
        })
        return child
      },
    })
    try {
      await expect(provider.resolve('TOKEN')).rejects.toMatchObject({
        code: 'E2E_SECRET_PROVIDER_EXECUTABLE_INVALID',
      })
      expect(closed).toBe(true)
      expect(captured.length).toBeGreaterThan(0)
      for (const plaintext of captured) {
        expect([...plaintext]).toEqual(new Array(plaintext.length).fill(0))
      }
      expect(child.listenerCount('close')).toBe(0)
      expect(child.stdout.listenerCount('data')).toBe(0)
    } finally {
      fromSpy.mockRestore()
      canary.fill(0)
      for (const plaintext of captured) plaintext.fill(0)
    }
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

  test('失败会先 SIGKILL 并等待真实 close，close 前不会返回', async () => {
    const child = fakeChild()
    let closed = false
    child.kill.mockImplementation(() => {
      queueMicrotask(() => { closed = true; child.emit('close', null, 'SIGKILL') })
      return true
    })
    const provider = createSystemSecretProvider({
      id: 'macos-keychain', platform: 'darwin', shutdownTimeoutMs: 50,
      inspectExecutable: async () => ({ device: '1', inode: '2' }),
      spawn: () => {
        queueMicrotask(() => child.stdout.emit('error', new Error('stream-secret')))
        return child
      },
    })
    await expect(provider.resolve('TOKEN')).rejects.toMatchObject({ code: 'E2E_SECRET_PROVIDER_UNAVAILABLE' })
    expect(closed).toBe(true)
    expect(child.kill).toHaveBeenCalledTimes(1)
  })

  test('真实 OS 子进程超时后必须完成 SIGKILL/close 才返回', async () => {
    let actuallyClosed = false
    const provider = createSystemSecretProvider({
      id: 'macos-keychain', platform: 'darwin', timeoutMs: 20, shutdownTimeoutMs: 1_000,
      inspectExecutable: async () => ({ device: '1', inode: '2' }),
      spawn: () => {
        const child = spawnChild(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
          shell: false, stdio: ['ignore', 'pipe', 'pipe'], env: {},
        })
        child.once('close', () => { actuallyClosed = true })
        return child as unknown as SecretProviderChild
      },
    })
    await expect(provider.resolve('TOKEN')).rejects.toMatchObject({
      code: 'E2E_SECRET_PROVIDER_TIMEOUT',
    })
    expect(actuallyClosed).toBe(true)
  })

  test.each([
    ['kill-false', false],
    ['kill-true-no-close', true],
  ] as const)('%s 不会无限挂起，返回脱敏的 shutdown 错误', async (_name, killResult) => {
    const child = fakeChild()
    child.kill.mockReturnValue(killResult)
    const provider = createSystemSecretProvider({
      id: 'macos-keychain', platform: 'darwin', timeoutMs: 1, shutdownTimeoutMs: 2,
      inspectExecutable: async () => ({ device: '1', inode: '2' }), spawn: () => child,
    })
    const error = await provider.resolve('TOKEN').catch((cause: unknown) => cause)
    expect(error).toMatchObject({ code: 'E2E_SECRET_PROVIDER_SHUTDOWN_FAILED' })
    expect(String(error)).not.toMatch(/kill-false|kill-true/)
    expect(child.kill).toHaveBeenCalledTimes(1)
    expect(child.listenerCount('close')).toBe(0)
    expect(child.stdout.listenerCount('data')).toBe(0)
    expect(child.stderr.listenerCount('data')).toBe(0)
  })

  test('close/error race 与 shutdown 期间 late data 不改写主错误，并清理所有 listener', async () => {
    const child = fakeChild()
    const late = Buffer.from('late-secret-canary')
    child.kill.mockImplementation(() => {
      queueMicrotask(() => {
        child.stdout.write(late)
        child.emit('close', null, 'SIGKILL')
        child.emit('error', new Error('late-child-error'))
      })
      return true
    })
    const provider = createSystemSecretProvider({
      id: 'macos-keychain', platform: 'darwin', shutdownTimeoutMs: 50,
      inspectExecutable: async () => ({ device: '1', inode: '2' }),
      spawn: () => {
        queueMicrotask(() => child.stderr.emit('error', new Error('primary-stream-error')))
        return child
      },
    })
    const error = await provider.resolve('TOKEN').catch((cause: unknown) => cause)
    expect(error).toMatchObject({ code: 'E2E_SECRET_PROVIDER_UNAVAILABLE' })
    expect(String(error)).not.toMatch(/late-secret|late-child|primary-stream/)
    expect([...late]).toEqual(new Array(late.length).fill(0))
    expect(child.listenerCount('close')).toBe(0)
    expect(child.listenerCount('error')).toBe(0)
    expect(child.stdout.listenerCount('data')).toBe(0)
    expect(child.stdout.listenerCount('error')).toBe(0)
    expect(child.stderr.listenerCount('data')).toBe(0)
    expect(child.stderr.listenerCount('error')).toBe(0)
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
  child.kill = vi.fn(() => {
    queueMicrotask(() => child.emit('close', null, 'SIGKILL'))
    return true
  })
  return child
}

function trustedLinuxBus(uid: number) {
  return {
    path: `/run/user/${uid}/bus`,
    directoryDevice: '1', directoryInode: '2',
    socketDevice: '1', socketInode: '3',
  }
}
