/** 可单测的 publication 顺序：冻结/drain 后只允许已由唯一 owner 终结的 write，再签审计。 */
export async function freezeDrainAndFinalize<T>(operations: {
  freezeAndDrain(): Promise<void>
  waitForTerminalSettlement(): Promise<void>
  assertWritesTerminal(): void
  signAudit(): T
}): Promise<T> {
  await operations.freezeAndDrain()
  await operations.waitForTerminalSettlement()
  operations.assertWritesTerminal()
  return operations.signAudit()
}
