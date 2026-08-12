import { pathToFileURL } from 'node:url'
import {
  BrowserCapabilityMatrixV1Schema,
  computeBrowserCapabilityMatrixDigest,
  digestText,
} from '@mutil-skills/e2e-contracts'

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
  componentProofDigest: string
  realProjectProofDigest?: string
  generatedAt?: string
}) {
  const supported = input.realProjectProofDigest !== undefined
  const entries = verified.map(([capabilityId, boundary, compilerSemantics]) => ({
    capabilityId,
    status: supported ? 'supported' as const : 'unverified-on-real-project' as const,
    boundary,
    compilerSemantics,
    componentProofDigest: input.componentProofDigest,
    ...(input.realProjectProofDigest === undefined ? {} : { realProjectProofDigest: input.realProjectProofDigest }),
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
    componentProofDigest: input.componentProofDigest,
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
  const componentProofDigest = process.env.E2E_COMPONENT_PROOF_DIGEST
  const realProjectProofDigest = process.env.E2E_REAL_PROJECT_PROOF_DIGEST
  if (componentProofDigest === undefined) throw new Error('E2E_COMPONENT_PROOF_DIGEST_REQUIRED')
  process.stdout.write(`${JSON.stringify(buildBrowserCapabilityMatrix({ componentProofDigest,
    ...(realProjectProofDigest === undefined ? {} : { realProjectProofDigest }) }), null, 2)}\n`)
}
