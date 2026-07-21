import { expect, test } from 'vitest'
import { AuthorityExecutionControlQueue } from '../src/authority-execution-control-queue.js'

test('control queue commits the first registration before a concurrent failure and accepts a retry', async () => {
  const queue = new AuthorityExecutionControlQueue()
  const events: string[] = []
  let releaseFirst!: () => void
  const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve })
  const first = queue.run(async () => {
    events.push('first-start')
    await firstGate
    events.push('first-registered')
    return 'registered'
  })
  const second = queue.run(async () => {
    events.push('second-start')
    throw Object.assign(new Error('registration failed'), { code: 'E2E_RPC_REGISTRATION_FAILED' })
  })

  await Promise.resolve()
  expect(events).toEqual(['first-start'])
  releaseFirst()
  await expect(first).resolves.toBe('registered')
  await expect(second).rejects.toMatchObject({ code: 'E2E_RPC_REGISTRATION_FAILED' })
  expect(events).toEqual(['first-start', 'first-registered', 'second-start'])
  await expect(queue.run(async () => {
    events.push('retry-registered')
    return 'retry-ok'
  })).resolves.toBe('retry-ok')
  await queue.drain()
  expect(events.at(-1)).toBe('retry-registered')
})
