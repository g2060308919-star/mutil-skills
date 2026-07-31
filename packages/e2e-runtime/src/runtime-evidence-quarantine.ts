import {
  E2EError,
  digestBytes,
  type QuarantineActor,
  type QuarantineEvidenceRecord,
} from '@mutil-skills/e2e-contracts'
import type { EncryptedQuarantine } from '@mutil-skills/e2e-engine'

declare const runtimeEvidenceQuarantineCapabilityBrand: unique symbol

export interface RuntimeEvidenceQuarantineCapability {
  readonly [runtimeEvidenceQuarantineCapabilityBrand]: true
}

export interface RuntimeQuarantinedEvidenceFacts {
  schemaVersion: '1.0.0'
  runId: string
  attemptId: string
  records: Array<{
    evidenceType: 'screenshot' | 'dom'
    quarantinePath: string
    plaintextDigest: string
    byteLength: number
  }>
}

type CaptureOperation = (input: {
  runId: string
  attemptId: string
  evidence: { screenshot: Uint8Array; dom: Uint8Array }
}) => Promise<RuntimeQuarantinedEvidenceFacts>

const capabilities = new WeakMap<object, CaptureOperation>()

export function authorizeRuntimeEvidenceQuarantine(
  operation: CaptureOperation,
): RuntimeEvidenceQuarantineCapability {
  const capability = Object.freeze({}) as RuntimeEvidenceQuarantineCapability
  capabilities.set(capability, operation)
  return capability
}

export async function quarantineRuntimeEvidence(
  capability: RuntimeEvidenceQuarantineCapability,
  input: Parameters<CaptureOperation>[0],
): Promise<RuntimeQuarantinedEvidenceFacts> {
  const operation = capabilities.get(capability)
  if (operation === undefined) throw evidenceError('E2E_RUNTIME_EVIDENCE_CAPABILITY_UNTRUSTED')
  const result = await operation(input)
  assertFacts(result, input)
  return structuredClone(result)
}

/** 原始 Browser bytes 的 production sink：先加密持久化，再允许 Host 写 completion。 */
export function createProductionEvidenceQuarantine(input: {
  quarantine: EncryptedQuarantine
  actor?: QuarantineActor
  ttlMs?: number
}): RuntimeEvidenceQuarantineCapability {
  const actor = input.actor ?? { subject: 'runtime:evidence-capture', roles: ['e2e-runner'] }
  const ttlMs = input.ttlMs ?? 24 * 60 * 60 * 1_000
  return authorizeRuntimeEvidenceQuarantine(async ({ runId, attemptId, evidence }) => {
    try {
      await input.quarantine.createRun({ runId, ttlMs, actor })
    } catch (error) {
      if (!(error instanceof Error
        && (error as NodeJS.ErrnoException).code === 'EEXIST')) throw error
      // 一个 PRD Run 可以串行执行多个 Case。目录已存在时，后续 writeEvidence
      // 会重新校验 active manifest、密文对象和 attempt 唯一路径，不能把任意
      // 预建目录当成可信 Quarantine。
    }
    const records: RuntimeQuarantinedEvidenceFacts['records'] = []
    for (const [evidenceType, bytes] of [
      ['screenshot', evidence.screenshot], ['dom', evidence.dom],
    ] as const) {
      const quarantinePath = `raw/${attemptId}/${evidenceType}.bin`
      const record = await input.quarantine.writeEvidence({
        runId, relativePath: quarantinePath, plaintext: bytes, actor,
      })
      records.push(persistedRecord(evidenceType, quarantinePath, record))
    }
    return { schemaVersion: '1.0.0', runId, attemptId, records }
  })
}

function persistedRecord(
  evidenceType: 'screenshot' | 'dom',
  quarantinePath: string,
  record: QuarantineEvidenceRecord,
): RuntimeQuarantinedEvidenceFacts['records'][number] {
  return {
    evidenceType, quarantinePath,
    plaintextDigest: record.plaintextDigest,
    byteLength: record.byteLength,
  }
}

function assertFacts(
  facts: RuntimeQuarantinedEvidenceFacts,
  input: Parameters<CaptureOperation>[0],
): void {
  if (facts.schemaVersion !== '1.0.0' || facts.runId !== input.runId
    || facts.attemptId !== input.attemptId || facts.records.length !== 2) {
    throw evidenceError('E2E_RUNTIME_EVIDENCE_FACTS_INVALID')
  }
  for (const [type, bytes] of [['screenshot', input.evidence.screenshot], ['dom', input.evidence.dom]] as const) {
    const record = facts.records.find((candidate) => candidate.evidenceType === type)
    if (record === undefined || !safeRelativePath(record.quarantinePath)
      || record.byteLength !== bytes.byteLength
      || record.plaintextDigest !== digestBytes('quarantine-plaintext/v1', bytes)) {
      throw evidenceError('E2E_RUNTIME_EVIDENCE_FACTS_INVALID')
    }
  }
}

function safeRelativePath(value: string): boolean {
  return value.length > 0 && !value.startsWith('/') && !value.includes('\\')
    && value.split('/').every((part) => part !== '' && part !== '.' && part !== '..')
}

function evidenceError(code: string): E2EError {
  return new E2EError({ code, category: 'safety', message: code, retryable: false })
}
