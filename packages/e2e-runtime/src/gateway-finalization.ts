/** 可单测的 finalize 顺序：先冻结并 drain，再等待 child terminal settlement，再收敛写状态，最后签审计。 */
export async function freezeDrainAndFinalize<T>(operations: {
  freezeAndDrain(): Promise<void>
  waitForTerminalSettlement(): Promise<void>
  settleWrites(): Promise<void>
  signAudit(): T
}): Promise<T> {
  await operations.freezeAndDrain()
  await operations.waitForTerminalSettlement()
  await operations.settleWrites()
  return operations.signAudit()
}
