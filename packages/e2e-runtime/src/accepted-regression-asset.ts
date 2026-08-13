import {
  AcceptedRegressionAssetV1Schema,
  RegressionAssetValiditySchema,
  canonicalizeJson,
  computeAcceptedRegressionAssetDigest,
  digestText,
  type AcceptedRegressionAssetV1,
  type RegressionAssetValidity,
} from '@mutil-skills/e2e-contracts'
import type { RuntimeRunSnapshot } from './run-store.js'
import { PrdUnderstandingPreparedFactSchema } from './local-approval-confirmations.js'
import { AcceptanceReviewReceiptSchema } from './acceptance-review.js'
import { ExecutableRunCompilationFactSchema } from './executable-run-compilation-fact.js'

export function createAcceptedRegressionAsset(input: {
  snapshot: RuntimeRunSnapshot
  runtimeVersion: string
  version: number
  createdAt: string
}): AcceptedRegressionAssetV1 {
  const snapshot = input.snapshot
  const prepared = PrdUnderstandingPreparedFactSchema.parse(
    snapshot.trustedExecutionFacts['prd-understanding-prepared'],
  )
  const review = AcceptanceReviewReceiptSchema.parse(
    snapshot.trustedExecutionFacts['acceptance-review-receipt'],
  )
  const executable = ExecutableRunCompilationFactSchema.parse(
    snapshot.trustedExecutionFacts['executable-run-compilation'],
  )
  if (snapshot.compiledPrdRun === undefined || snapshot.targetContract === undefined) {
    throw new Error('E2E_REGRESSION_ASSET_PREREQUISITE_MISSING')
  }
  const execution = record(snapshot.frozenArtifacts['execution-contract']?.content)
  const actorDataContractDigest = digestText('accepted-regression-actor-data-contract/v1', canonicalizeJson({
    identities: sanitizeIdentities(execution.identities),
    dataNeeds: sanitizeDataNeeds(execution.dataNeeds),
  }))
  const target = snapshot.targetContract.contract
  const body = {
    schemaVersion: 'accepted-regression-asset/v1' as const,
    assetId: snapshot.assetId,
    version: input.version,
    sourceRevision: requiredDigest(snapshot.artifactDigests['prd-source']),
    understandingDigest: prepared.projection.projectionDigest,
    semanticPlanDigest: snapshot.compiledPrdRun.compilerDigest,
    acceptanceReviewReceiptDigest: review.receiptDigest,
    executableCompilationDigest: executable.compilerDigest,
    targetIdentityContract: {
      baseOrigin: target.baseOrigin,
      environmentLabel: target.environmentLabel,
      allowedNavigationOrigins: [...target.allowedNavigationOrigins].sort(),
      pageIdentityPolicyDigest: digestText(
        'accepted-regression-page-identity/v1', canonicalizeJson(target.pageIdentityPolicy),
      ),
    },
    actorDataContractDigest,
    runtimeCompatibility: { packageName: '@mutil-skills/e2e-runtime' as const,
      range: compatibleMinorRange(input.runtimeVersion) },
    browserCapabilities: deriveBrowserCapabilities(execution),
    humanAmendments: [],
    createdAt: input.createdAt,
  }
  return AcceptedRegressionAssetV1Schema.parse({
    ...body,
    assetDigest: computeAcceptedRegressionAssetDigest(body),
  })
}

export function evaluateRegressionAssetValidity(input: {
  asset: AcceptedRegressionAssetV1
  current: {
    sourceRevision: string
    understandingDigest: string
    semanticPlanDigest: string
    targetIdentityContract: AcceptedRegressionAssetV1['targetIdentityContract']
    actorDataContractDigest: string
    runtimeVersion: string
    browserCapabilities: string[]
  }
  probe?: { status: 'not-run' | 'locator-drift'; refs: string[] }
}): RegressionAssetValidity {
  const asset = AcceptedRegressionAssetV1Schema.parse(input.asset)
  const blocked = [] as Array<{ code: string; ref: string }>
  if (asset.actorDataContractDigest !== input.current.actorDataContractDigest) {
    blocked.push({ code: 'E2E_REGRESSION_ACTOR_DATA_CHANGED', ref: 'actor-data' })
  }
  if (!runtimeCompatible(asset.runtimeCompatibility.range, input.current.runtimeVersion)) {
    blocked.push({ code: 'E2E_REGRESSION_RUNTIME_INCOMPATIBLE', ref: input.current.runtimeVersion })
  }
  for (const capability of asset.browserCapabilities) {
    if (!input.current.browserCapabilities.includes(capability)) blocked.push({
      code: 'E2E_REGRESSION_BROWSER_CAPABILITY_MISSING', ref: capability,
    })
  }
  if (blocked.length > 0) return RegressionAssetValiditySchema.parse({
    status: 'execution-blocked', reasons: blocked,
  })
  const reviewBindings = [
    ['source', asset.sourceRevision, input.current.sourceRevision],
    ['understanding', asset.understandingDigest, input.current.understandingDigest],
    ['semantic-plan', asset.semanticPlanDigest, input.current.semanticPlanDigest],
    ['target', digestText('accepted-regression-target/v1', canonicalizeJson(asset.targetIdentityContract)),
      digestText('accepted-regression-target/v1', canonicalizeJson(input.current.targetIdentityContract))],
  ] as const
  const changed = reviewBindings.filter(([, previous, current]) => previous !== current)
  if (changed.length > 0) return RegressionAssetValiditySchema.parse({
    status: 'review-required', reasons: changed.map(([binding]) => ({
      code: `E2E_REGRESSION_${binding.toUpperCase().replaceAll('-', '_')}_CHANGED`, ref: binding,
    })),
    diff: { changedBindings: changed.map(([binding]) => binding),
      previousDigest: digestText('accepted-regression-validity-side/v1',
        canonicalizeJson(changed.map(([binding, previous]) => [binding, previous]))),
      currentDigest: digestText('accepted-regression-validity-side/v1',
        canonicalizeJson(changed.map(([binding, , current]) => [binding, current]))) },
  })
  if (input.probe !== undefined) return RegressionAssetValiditySchema.parse({
    status: 'probe-required',
    reasons: input.probe.status === 'locator-drift'
      ? input.probe.refs.map((ref) => ({ code: 'E2E_REGRESSION_LOCATOR_DRIFT', ref }))
      : [{ code: 'E2E_REGRESSION_TARGET_PROBE_REQUIRED', ref: asset.assetId }],
  })
  return { status: 'valid' }
}

export function replayFrozenRegressionAsset(input: {
  asset: AcceptedRegressionAssetV1
  runtimeVersion: string
  browserCapabilities: string[]
}): {
  assetDigest: string
  generatorInvoked: false
  semanticMutationAllowed: false
  requiredFreshFacts: ['target-probe', 'execution-approval', 'data-lease']
  validity: RegressionAssetValidity
} {
  const asset = AcceptedRegressionAssetV1Schema.parse(input.asset)
  const incompatibleReasons = [
    ...(!runtimeCompatible(asset.runtimeCompatibility.range, input.runtimeVersion)
      ? [{ code: 'E2E_REGRESSION_RUNTIME_INCOMPATIBLE', ref: input.runtimeVersion }] : []),
    ...asset.browserCapabilities.filter((capability) => !input.browserCapabilities.includes(capability))
      .map((ref) => ({ code: 'E2E_REGRESSION_BROWSER_CAPABILITY_MISSING', ref })),
  ]
  const validity = incompatibleReasons.length > 0
    ? RegressionAssetValiditySchema.parse({ status: 'execution-blocked', reasons: incompatibleReasons })
    : RegressionAssetValiditySchema.parse({ status: 'probe-required', reasons: [{
      code: 'E2E_REGRESSION_TARGET_PROBE_REQUIRED', ref: asset.assetId,
    }] })
  return {
    assetDigest: asset.assetDigest,
    generatorInvoked: false,
    semanticMutationAllowed: false,
    requiredFreshFacts: ['target-probe', 'execution-approval', 'data-lease'],
    validity,
  }
}

export function amendAcceptedRegressionAsset(input: {
  previous: AcceptedRegressionAssetV1
  actor: string
  reason: string
  changedAt: string
}): AcceptedRegressionAssetV1 {
  const previous = AcceptedRegressionAssetV1Schema.parse(input.previous)
  const amendmentBase = {
    amendmentId: `AMENDMENT-${previous.version + 1}`,
    actor: input.actor,
    reason: input.reason,
    changedAt: input.changedAt,
    previousAssetDigest: previous.assetDigest,
  }
  const amendment = {
    ...amendmentBase,
    amendmentDigest: digestText('accepted-regression-amendment/v1', canonicalizeJson(amendmentBase)),
  }
  const { assetDigest: _assetDigest, ...previousBody } = previous
  const body = {
    ...previousBody,
    version: previous.version + 1,
    humanAmendments: [...previous.humanAmendments, amendment],
    createdAt: input.changedAt,
  }
  return AcceptedRegressionAssetV1Schema.parse({ ...body,
    assetDigest: computeAcceptedRegressionAssetDigest(body) })
}

export function regenerateAcceptedRegressionAsset(input: {
  previous: AcceptedRegressionAssetV1
  candidate: AcceptedRegressionAssetV1
  actor: string
  reason: string
  changedAt: string
}): {
  asset: AcceptedRegressionAssetV1
  diff: { changedBindings: string[]; previousDigest: string; currentDigest: string }
} {
  const previous = AcceptedRegressionAssetV1Schema.parse(input.previous)
  const candidate = AcceptedRegressionAssetV1Schema.parse(input.candidate)
  if (candidate.assetId !== previous.assetId || candidate.version !== previous.version + 1) {
    throw new Error('E2E_REGRESSION_VERSION_LINEAGE_INVALID')
  }
  const bindings = [
    ['source', previous.sourceRevision, candidate.sourceRevision],
    ['understanding', previous.understandingDigest, candidate.understandingDigest],
    ['semantic-plan', previous.semanticPlanDigest, candidate.semanticPlanDigest],
    ['execution-binding', previous.executableCompilationDigest, candidate.executableCompilationDigest],
    ['target', canonicalizeJson(previous.targetIdentityContract), canonicalizeJson(candidate.targetIdentityContract)],
    ['actor-data', previous.actorDataContractDigest, candidate.actorDataContractDigest],
    ['runtime', canonicalizeJson(previous.runtimeCompatibility), canonicalizeJson(candidate.runtimeCompatibility)],
    ['browser-capability', canonicalizeJson(previous.browserCapabilities), canonicalizeJson(candidate.browserCapabilities)],
  ] as const
  const changedBindings = bindings.filter(([, left, right]) => left !== right).map(([name]) => name)
  if (changedBindings.length === 0) throw new Error('E2E_REGRESSION_REGENERATE_NO_CHANGE')
  const amendmentBase = { amendmentId: `AMENDMENT-${candidate.version}`, actor: input.actor,
    reason: input.reason, changedAt: input.changedAt, previousAssetDigest: previous.assetDigest }
  const amendment = { ...amendmentBase,
    amendmentDigest: digestText('accepted-regression-amendment/v1', canonicalizeJson(amendmentBase)) }
  const { assetDigest: _assetDigest, ...candidateBody } = candidate
  const body = { ...candidateBody,
    humanAmendments: [...previous.humanAmendments, amendment], createdAt: input.changedAt }
  const asset = AcceptedRegressionAssetV1Schema.parse({ ...body,
    assetDigest: computeAcceptedRegressionAssetDigest(body) })
  return { asset, diff: { changedBindings,
    previousDigest: previous.assetDigest, currentDigest: asset.assetDigest } }
}

function sanitizeIdentities(value: unknown): unknown[] {
  return array(value).map((item) => {
    const identity = record(item)
    return { identityId: identity.identityId, roleIds: identity.roleIds }
  })
}
function sanitizeDataNeeds(value: unknown): unknown[] {
  return array(value).map((item) => {
    const need = record(item)
    return { resourceKey: need.resourceKey, resourceFingerprint: need.resourceFingerprint, mode: need.mode }
  })
}
function deriveBrowserCapabilities(execution: Record<string, unknown>): string[] {
  return [...new Set(['chrome', 'dom', ...(execution.executionProfile === 'declarative-browser'
    ? ['declarative-browser'] : [])])].sort()
}
function compatibleMinorRange(version: string): string {
  const match = /^(\d+)\.(\d+)\.\d+$/.exec(version)
  if (match === null) throw new Error('E2E_REGRESSION_RUNTIME_VERSION_INVALID')
  return `^${match[1]}.${match[2]}.0`
}
function runtimeCompatible(range: string, version: string): boolean {
  const expected = /^\^(\d+)\.(\d+)\.0$/.exec(range)
  const actual = /^(\d+)\.(\d+)\.\d+$/.exec(version)
  return expected !== null && actual !== null && expected[1] === actual[1] && expected[2] === actual[2]
}
function requiredDigest(value: unknown): string {
  if (typeof value !== 'string') throw new Error('E2E_REGRESSION_SOURCE_REVISION_REQUIRED')
  return value
}
function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown> : {}
}
function array(value: unknown): unknown[] { return Array.isArray(value) ? value : [] }
