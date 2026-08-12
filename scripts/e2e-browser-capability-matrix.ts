import { pathToFileURL } from 'node:url'
import {
  E2EBenchmarkProofV1Schema,
  BrowserCapabilityMatrixV1Schema,
  computeBrowserCapabilityMatrixDigest,
  digestText,
} from '@mutil-skills/e2e-contracts'
import { readFile } from 'node:fs/promises'

interface ComponentProofSummary {
  schemaVersion: '1.0.0'
  proofKind: 'browser-capability'
  proofDigest: string
  passed: boolean
  gateEligible: boolean
}

interface RealProjectProofSummary {
  schemaVersion: 'e2e-benchmark-proof/v1'
  proofKind: 'real-project'
  proofDigest: string
  gate: { eligible: boolean; passed: boolean }
}

const verified = [
  ['CAP-locator-strict-actionable', '唯一 locator 与可操作性', 'role/test-id/css/text strict locator'],
  ['CAP-spa-page-identity', 'SPA route 与页面身份', 'navigate + Target page identity'],
  ['CAP-overlay-dialog', 'Portal/Overlay/Dialog', 'role locator + bounded actionability'],
  ['CAP-eventually', '明确最终状态等待', 'eventually Oracle deadline'],
  ['CAP-table-filter-sort-page', '表格查询排序筛选分页', '结构化 action + text/composite Oracle'],
  ['CAP-dynamic-form', '动态表单与校验', 'select/fill + visibility/text Oracle'],
  ['CAP-download-content', 'Download 完成和内容', 'download Oracle'],
  ['CAP-permission-negative', '权限入口缺失与绕过负向', 'absence/network Oracle'],
  ['CAP-reload-cleanup', 'Reload 持久状态与 Cleanup 不存在', 'reload-state + cleanup intent'],
  ['CAP-console-network', 'Console 与 request/response', 'console/network Oracle'],
] as const

export function buildBrowserCapabilityMatrix(input: {
  componentProof: ComponentProofSummary
  realProjectProof?: RealProjectProofSummary
  generatedAt?: string
}) {
  const componentProofDigest = requireDigest(input.componentProof.proofDigest)
  const realProjectProofDigest = input.realProjectProof === undefined
    ? undefined : requireDigest(input.realProjectProof.proofDigest)
  const supported = input.componentProof.schemaVersion === '1.0.0'
    && input.componentProof.proofKind === 'browser-capability'
    && input.componentProof.passed && input.componentProof.gateEligible
    && input.realProjectProof?.schemaVersion === 'e2e-benchmark-proof/v1'
    && input.realProjectProof.proofKind === 'real-project'
    && input.realProjectProof.gate.eligible && input.realProjectProof.gate.passed
  const entries = verified.map(([capabilityId, boundary, compilerSemantics]) => ({
    capabilityId,
    status: supported ? 'supported' as const : 'unverified-on-real-project' as const,
    boundary,
    compilerSemantics,
    componentProofDigest,
    ...(realProjectProofDigest === undefined ? {} : { realProjectProofDigest }),
    failureClassification: 'Oracle business failure; environment/capability separately classified',
    timeoutCancellation: 'bounded deadline; active cancellation is Spec 5',
    oracleEvidence: ['screenshot', 'dom', 'url', 'network', 'console'],
    cleanup: 'Runtime-owned context/profile and declared cleanup',
    retryRecovery: 'read-only only; uncertain write never auto-replayed',
    verifiedHosts: supported ? [`${process.platform}-${process.arch}`] : [],
    verifiedChrome: supported ? ['system-chrome-stable'] : [],
  }))
  entries.push({
    capabilityId: 'CAP-iframe-popup-identity', status: 'unverified-on-real-project' as const,
    boundary: '组件 proof 已覆盖 iframe/popup，多 page 真实复杂样本尚未闭环',
    compilerSemantics: 'pageScope/pageId/frame identity currently full-playwright only',
    componentProofDigest,
    failureClassification: 'identity mismatch fail-closed', timeoutCancellation: 'bounded deadline',
    oracleEvidence: ['screenshot', 'dom', 'url'], cleanup: 'close popup/context',
    retryRecovery: 'read-only identity-bound retry', verifiedHosts: [], verifiedChrome: [],
  })
  entries.push({
    capabilityId: 'CAP-backend-auth', status: 'fail-closed' as const,
    boundary: 'Mock backend/IdP 不能证明真实后端鉴权', compilerSemantics: 'claim remains not-verified',
    failureClassification: 'substituted component', timeoutCancellation: 'not-applicable',
    oracleEvidence: [], cleanup: 'fixture only', retryRecovery: 'requires real controlled environment',
    verifiedHosts: [], verifiedChrome: [],
  })
  const body = { schemaVersion: 'browser-capability-matrix/v1' as const, matrixVersion: '1.0.0',
    runnerIdentityDigest: digestText('browser-capability-matrix-runner/v1', 'mutil-skills-0.8'),
    entries, generatedAt: input.generatedAt ?? new Date().toISOString() }
  return BrowserCapabilityMatrixV1Schema.parse({ ...body,
    matrixDigest: computeBrowserCapabilityMatrixDigest(body) })
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const componentPath = process.env.E2E_COMPONENT_PROOF_PATH
  const realProjectPath = process.env.E2E_REAL_PROJECT_PROOF_PATH
  if (componentPath === undefined) throw new Error('E2E_COMPONENT_PROOF_PATH_REQUIRED')
  const componentProof = parseComponentProof(JSON.parse(await readFile(componentPath, 'utf8')))
  const realProjectProof = realProjectPath === undefined ? undefined
    : E2EBenchmarkProofV1Schema.parse(JSON.parse(await readFile(realProjectPath, 'utf8')))
  process.stdout.write(`${JSON.stringify(buildBrowserCapabilityMatrix({ componentProof,
    ...(realProjectProof === undefined ? {} : { realProjectProof }) }), null, 2)}\n`)
}

function parseComponentProof(value: unknown): ComponentProofSummary {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('E2E_COMPONENT_PROOF_INVALID')
  }
  const proof = value as Record<string, unknown>
  if (proof.schemaVersion !== '1.0.0' || proof.proofKind !== 'browser-capability'
    || typeof proof.proofDigest !== 'string' || typeof proof.passed !== 'boolean'
    || typeof proof.gateEligible !== 'boolean') throw new Error('E2E_COMPONENT_PROOF_INVALID')
  return { schemaVersion: '1.0.0', proofKind: 'browser-capability',
    proofDigest: proof.proofDigest, passed: proof.passed, gateEligible: proof.gateEligible }
}

function requireDigest(value: string): string {
  if (!/^sha256:[a-f0-9]{64}$/.test(value)) throw new Error('E2E_PROOF_DIGEST_INVALID')
  return value
}
