import { describe, expect, test, vi } from 'vitest'
import { runWithTransientNpmRetry } from './npm-transient-retry.js'

describe('npm 瞬时网络错误重试', () => {
  test('只对明确的瞬时网络错误复用同一操作并有限重试', async () => {
    const operation = vi.fn()
      .mockRejectedValueOnce(Object.assign(new Error('npm install failed'), {
        code: 'ETIMEDOUT', stderr: 'npm error network read ETIMEDOUT',
      }))
      .mockResolvedValue('installed')
    const wait = vi.fn().mockResolvedValue(undefined)

    await expect(runWithTransientNpmRetry(operation, { maxAttempts: 2, wait })).resolves.toBe('installed')
    expect(operation).toHaveBeenCalledTimes(2)
    expect(wait).toHaveBeenCalledTimes(1)
  })

  test('完整性或鉴权错误立即失败且不重试', async () => {
    const failure = Object.assign(new Error('npm install failed'), {
      code: 'EINTEGRITY', stderr: 'npm error code EINTEGRITY',
    })
    const operation = vi.fn().mockRejectedValue(failure)

    await expect(runWithTransientNpmRetry(operation, { maxAttempts: 2 })).rejects.toBe(failure)
    expect(operation).toHaveBeenCalledTimes(1)
  })

  test('瞬时错误达到上限后保留最后一次原始失败', async () => {
    const first = Object.assign(new Error('first timeout'), { code: 'ETIMEDOUT' })
    const second = Object.assign(new Error('second timeout'), { code: 'ECONNRESET' })
    const operation = vi.fn().mockRejectedValueOnce(first).mockRejectedValueOnce(second)

    await expect(runWithTransientNpmRetry(operation, {
      maxAttempts: 2, wait: async () => undefined,
    })).rejects.toBe(second)
    expect(operation).toHaveBeenCalledTimes(2)
  })
})
