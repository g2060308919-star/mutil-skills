import {
  canonicalizeJson,
  digestText,
  type QuarantineAuditEvent,
} from '@mutil-skills/e2e-contracts'

export interface QuarantineAuditSink {
  append(input: Omit<QuarantineAuditEvent, 'sequence' | 'previousChainDigest' | 'eventDigest'>): Promise<void>
}

export class InMemoryQuarantineAuditLog implements QuarantineAuditSink {
  readonly #events: QuarantineAuditEvent[] = []
  #chainDigest = digestText('quarantine-audit-root/v1', 'root')

  get events(): QuarantineAuditEvent[] {
    return this.#events.map((event) => ({ ...event, actorRoles: [...event.actorRoles] }))
  }

  async append(input: Omit<QuarantineAuditEvent, 'sequence' | 'previousChainDigest' | 'eventDigest'>): Promise<void> {
    const core = {
      ...input,
      actorRoles: [...input.actorRoles].sort(),
      sequence: this.#events.length + 1,
      previousChainDigest: this.#chainDigest,
    }
    const eventDigest = digestText('quarantine-audit-event/v1', canonicalizeJson(core))
    const event: QuarantineAuditEvent = { ...core, eventDigest }
    this.#events.push(event)
    this.#chainDigest = digestText('quarantine-audit-chain/v1', canonicalizeJson({
      previous: this.#chainDigest, event: eventDigest,
    }))
  }
}

export function verifyQuarantineAuditChain(events: QuarantineAuditEvent[]): boolean {
  let chainDigest = digestText('quarantine-audit-root/v1', 'root')
  for (const [index, event] of events.entries()) {
    if (event.sequence !== index + 1 || event.previousChainDigest !== chainDigest) return false
    const { eventDigest, ...core } = event
    if (eventDigest !== digestText('quarantine-audit-event/v1', canonicalizeJson(core))) return false
    chainDigest = digestText('quarantine-audit-chain/v1', canonicalizeJson({
      previous: chainDigest, event: eventDigest,
    }))
  }
  return true
}
