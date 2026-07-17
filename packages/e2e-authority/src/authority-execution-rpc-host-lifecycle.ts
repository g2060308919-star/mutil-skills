export interface AuthorityExecutionRpcHostResources {
  webAuthnAuthority?: { revokePendingSessions(): void }
  approvalServers: Iterable<{ close(): Promise<void> }>
  httpHandle?: { close(): Promise<void> }
  executionRpc?: { destroy(): void }
  approvalAuthority?: { close(): void }
  leaseAuthority?: { close(): void }
}

export async function closeAuthorityExecutionRpcHostResources(
  resources: AuthorityExecutionRpcHostResources,
): Promise<void> {
  const operations: Array<() => void | Promise<void>> = [
    () => resources.webAuthnAuthority?.revokePendingSessions(),
    ...[...resources.approvalServers].map((server) => async () => await server.close()),
    async () => await resources.httpHandle?.close(),
    () => resources.executionRpc?.destroy(),
    () => resources.approvalAuthority?.close(),
    () => resources.leaseAuthority?.close(),
  ]
  const outcomes = await Promise.allSettled(operations.map(async (operation) => await operation()))
  const errors = outcomes.flatMap((outcome) => outcome.status === 'rejected' ? [outcome.reason] : [])
  if (errors.length > 0) {
    throw new AggregateError(errors, 'E2E_RPC_HOST_RESOURCE_CLEANUP_FAILED')
  }
}
