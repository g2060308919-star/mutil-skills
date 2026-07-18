export async function persistFinalizedApprovalOutcome<T>(options: {
  persist(): Promise<T>
  acknowledge(): Promise<void>
  persistencePending(cause: unknown): Error
}): Promise<T> {
  let outcome: T
  try {
    outcome = await options.persist()
  } catch (cause) {
    throw options.persistencePending(cause)
  }
  try { await options.acknowledge() }
  catch { /* Durable outcome wins; exact idempotent ACK is retried or pruned later. */ }
  return outcome
}
