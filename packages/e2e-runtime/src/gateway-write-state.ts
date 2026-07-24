import type {
  CompleteExecutionOutcomeInput,
  GatewayTerminalOutcome,
  ReversibleWriteGateway,
} from '@mutil-skills/e2e-gateway'
import type { ExecutionOutcomeReceipt, GatewayAuditSummary } from '@mutil-skills/e2e-contracts'

type WriteState = 'reserved' | 'transport-observed' | 'finalizing' | 'marking-unknown' | 'finalized' | 'unknown' | 'terminal-failed'

interface WriteRecord {
  capabilityId: string
  gateway: ReversibleWriteGateway
  requestIds: Set<string>
  responseObserved: Set<string>
  state: WriteState
  operation?: Promise<unknown>
  terminalError?: unknown
}

/**
 * 每个 write reservation 的单一终态协调器。所有终态在首个 await 前 claim，
 * 因此 finalize、unknown、close 与 child-exit 不能对同一 reservation 双重提交。
 */
export class GatewayWriteStateCoordinator {
  readonly #records = new Map<ReversibleWriteGateway, WriteRecord>()
  readonly #requests = new Map<string, WriteRecord>()

  observeReservation(requestId: string, capabilityId: string, gateway: ReversibleWriteGateway): void {
    let record = this.#records.get(gateway)
    if (!record) {
      record = { capabilityId, gateway, requestIds: new Set(), responseObserved: new Set(), state: 'reserved' }
      this.#records.set(gateway, record)
    }
    if (record.capabilityId !== capabilityId || isTerminal(record.state)
      || ['finalizing', 'marking-unknown'].includes(record.state) || this.#requests.has(requestId)) {
      throw writeStateError('E2E_GATEWAY_WRITE_STATE_INVALID')
    }
    record.state = 'reserved'
    record.requestIds.add(requestId)
    this.#requests.set(requestId, record)
  }

  observeTransport(requestId: string): void {
    const record = this.#requests.get(requestId)
    if (!record || record.state !== 'reserved') return
    record.responseObserved.add(requestId)
    record.state = record.responseObserved.size === record.requestIds.size && record.gateway.isRequestSequenceComplete()
      ? 'transport-observed' : 'reserved'
  }

  async markRequestUnknown(requestId: string, observation: string): Promise<void> {
    const record = this.#requests.get(requestId)
    if (record) await this.#claimUnknown(record, observation)
  }

  async finalize(
    capabilityId: string,
    input: CompleteExecutionOutcomeInput,
  ): Promise<GatewayTerminalOutcome> {
    const record = this.#findCapability(capabilityId)
    if (record.state !== 'transport-observed') {
      if (record.terminalError) throw record.terminalError
      throw writeStateError('E2E_GATEWAY_WRITE_TRANSPORT_NOT_OBSERVED')
    }
    // 原子 claim 必须发生在 Authority await 之前。
    record.state = 'finalizing'
    const operation = (async () => {
      try {
        const receipt = await record.gateway.completeWithExecutionOutcomeResult(input)
        record.state = 'finalized'
        this.#release(record)
        return receipt
      } catch (error) {
        // Authority 是否已提交可能未知；禁止随后 markUnknown 形成双终态。
        record.state = 'terminal-failed'
        record.terminalError = error
        throw error
      }
    })()
    record.operation = operation
    return await operation
  }

  async markCapabilityUnknown(capabilityId: string, observation: string): Promise<string> {
    return await this.#claimUnknown(this.#findCapability(capabilityId), observation)
  }

  async markCapabilityUnknownWithOutcome(
    capabilityId: string,
    input: CompleteExecutionOutcomeInput,
    observation: string,
  ): Promise<GatewayTerminalOutcome> {
    const record = this.#findCapability(capabilityId)
    if (record.state !== 'transport-observed') {
      if (record.terminalError) throw record.terminalError
      throw writeStateError('E2E_GATEWAY_WRITE_TRANSPORT_NOT_OBSERVED')
    }
    record.state = 'marking-unknown'
    const operation = (async () => {
      try {
        const result = await record.gateway.markUnknownWithExecutionOutcome(input, observation)
        record.state = 'unknown'
        this.#release(record)
        return result
      } catch (error) {
        record.state = 'terminal-failed'
        record.terminalError = error
        throw error
      }
    })()
    record.operation = operation
    return await operation
  }

  async settleAllUnknown(observation: string): Promise<void> {
    const errors: unknown[] = []
    await Promise.all([...this.#records.values()].map(async (record) => {
      try {
        if (record.state === 'finalized' || record.state === 'unknown') return
        if (record.state === 'finalizing' || record.state === 'marking-unknown') {
          await record.operation
          return
        }
        if (record.state === 'terminal-failed') throw record.terminalError
        await this.#claimUnknown(record, observation)
      } catch (error) { errors.push(error) }
    }))
    if (errors.length > 0) throw new AggregateError(errors, 'E2E_GATEWAY_WRITE_SETTLEMENT_FAILED')
  }

  get unsettledCount(): number {
    return this.#records.size
  }

  auditSummary(capabilityId: string): GatewayAuditSummary {
    return this.#findCapability(capabilityId).gateway.getAuditSummary()
  }

  async #claimUnknown(record: WriteRecord, observation: string): Promise<string> {
    if (record.state === 'unknown' || record.state === 'finalized') {
      throw writeStateError('E2E_GATEWAY_WRITE_ALREADY_TERMINAL')
    }
    if (record.state === 'terminal-failed') throw record.terminalError
    if (record.state === 'finalizing' || record.state === 'marking-unknown') {
      return await record.operation as string
    }
    // 原子 claim 必须发生在 Authority await 之前。
    record.state = 'marking-unknown'
    const operation = (async () => {
      try {
        const receiptDigest = await record.gateway.markUnknown(observation)
        record.state = 'unknown'
        this.#release(record)
        return receiptDigest
      } catch (error) {
        record.state = 'terminal-failed'
        record.terminalError = error
        throw error
      }
    })()
    record.operation = operation
    return await operation
  }

  #findCapability(capabilityId: string): WriteRecord {
    const matches = [...this.#records.values()].filter((record) => record.capabilityId === capabilityId)
    if (matches.length !== 1) throw writeStateError('E2E_GATEWAY_WRITE_CAPABILITY_NOT_ACTIVE')
    return matches[0]!
  }

  #release(record: WriteRecord): void {
    for (const requestId of record.requestIds) this.#requests.delete(requestId)
    record.requestIds.clear()
    record.responseObserved.clear()
    this.#records.delete(record.gateway)
    record.operation = undefined
  }
}

function isTerminal(state: WriteState): boolean {
  return state === 'finalized' || state === 'unknown' || state === 'terminal-failed'
}

function writeStateError(code: string): Error {
  return Object.assign(new Error(code), { code })
}
