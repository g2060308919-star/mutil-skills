import { expect, test, vi } from 'vitest'
import { persistFinalizedApprovalOutcome } from '../src/finalized-approval-outcome.js'

test('persists before acknowledgement and ignores acknowledgement failure after durable success', async () => {
  const events: string[] = []
  const outcome = { ok: true }
  await expect(persistFinalizedApprovalOutcome({
    persist: async () => { events.push('persist'); return outcome },
    acknowledge: async () => { events.push('ack'); throw new Error('lost ack') },
    persistencePending: (cause) => new AggregateError([cause], 'pending'),
  })).resolves.toBe(outcome)
  expect(events).toEqual(['persist', 'ack'])
})

test('maps persistence failure to pending without acknowledging an uncommitted outcome', async () => {
  const cause = new Error('fsync failed')
  const pending = new Error('pending')
  const acknowledge = vi.fn(async () => undefined)
  await expect(persistFinalizedApprovalOutcome({
    persist: async () => { throw cause }, acknowledge,
    persistencePending: (observed) => {
      expect(observed).toBe(cause)
      return pending
    },
  })).rejects.toBe(pending)
  expect(acknowledge).not.toHaveBeenCalled()
})
