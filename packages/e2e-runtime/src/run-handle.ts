import {
  RunHandleSchema,
  canonicalizeJson,
  digestText,
  E2EError,
  type RunHandle,
} from '@mutil-skills/e2e-contracts'
import type { RuntimeRunSnapshot } from './run-store.js'

export function createRunHandle(snapshot: RuntimeRunSnapshot): RunHandle {
  return RunHandleSchema.parse({
    assetId: snapshot.assetId,
    runId: snapshot.runId,
    revision: snapshot.runRevision ?? 0,
    generationDigest: digestText('e2e-run-generation/v1', canonicalizeJson({
      assetId: snapshot.assetId,
      runId: snapshot.runId,
      prdRevision: snapshot.artifactDigests['prd-source'],
      ...(snapshot.compiledPrdRun === undefined
        ? {} : { compilerDigest: snapshot.compiledPrdRun.compilerDigest }),
    })),
  })
}

export function assertRunHandle(snapshot: RuntimeRunSnapshot, candidate: unknown): RunHandle {
  const handle = RunHandleSchema.safeParse(candidate)
  if (!handle.success) throw handleError('E2E_RUN_HANDLE_INVALID')
  const expected = createRunHandle(snapshot)
  if (handle.data.revision !== expected.revision) {
    throw handleError('E2E_RUN_HANDLE_REVISION_STALE')
  }
  if (handle.data.assetId !== expected.assetId
    || handle.data.runId !== expected.runId
    || handle.data.generationDigest !== expected.generationDigest) {
    throw handleError('E2E_RUN_HANDLE_BINDING_MISMATCH')
  }
  return handle.data
}

function handleError(code: string): E2EError {
  return new E2EError({ code, category: 'safety', message: code, retryable: false })
}
