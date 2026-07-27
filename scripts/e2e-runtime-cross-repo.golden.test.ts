import { mkdtemp, readFile, readdir, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { runCrossRepoRuntimeGolden } from './e2e-runtime-cross-repo.js'
import { discoverSystemChrome } from '../packages/e2e-runtime/src/system-chrome.js'

const roots: string[] = []
const crossRepoRequested = process.env.E2E_RUNTIME_RUN_CROSS_REPO === '1'
const publishedPackages = [
  '@mutil-skills/cli', '@mutil-skills/core', '@mutil-skills/e2e-authority',
  '@mutil-skills/e2e-contracts', '@mutil-skills/e2e-engine', '@mutil-skills/e2e-gateway',
  '@mutil-skills/e2e-playwright-runtime', '@mutil-skills/e2e-report', '@mutil-skills/e2e-runtime',
  '@mutil-skills/foundation', '@mutil-skills/hooks', '@mutil-skills/schema',
  '@mutil-skills/skills', '@mutil-skills/template',
].sort()

afterEach(async () => {
  if (process.env.E2E_RUNTIME_PRESERVE_CROSS_REPO === '1') {
    for (const root of roots.splice(0)) process.stderr.write(`E2E_RUNTIME_PRESERVED_ROOT:${root}\n`)
    return
  }
  await Promise.all(roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true })))
})

describe('portable E2E runtime', () => {
  test.skipIf(!crossRepoRequested)(
    'runs from packed artifacts in a blank project without source paths',
    async () => {
      if (process.env.E2E_RUNTIME_SYSTEM_CHROME_EXECUTABLE === undefined) {
        await discoverSystemChrome().catch((cause) => {
          throw Object.assign(new Error('E2E_RUNTIME_SYSTEM_CHROME_REQUIRED'), { cause })
        })
      }
      const root = await mkdtemp(join(tmpdir(), 'mutil-e2e-cross-repo-'))
      roots.push(root)
      // macOS 的 tmpdir() 通常位于 /var，而 /var 是指向 /private/var 的系统符号链接。
      // Runtime 的 owner marker 明确拒绝任何非 canonical 父路径，因此 Golden 必须像
      // 生产受控目录一样，从已解析的真实根目录构造 HOME、项目与 tarball 路径。
      const canonicalRoot = await realpath(root)
      const home = join(canonicalRoot, 'home')
      const project = join(canonicalRoot, 'user-project')
      const packs = join(canonicalRoot, 'packs')
      const result = await runCrossRepoRuntimeGolden({ home, project, packs })

      if (process.env.E2E_RUNTIME_TODOMVC_ONLY === '1') {
        expect(result.doctor.ready).toBe(true)
        expect(result.todoMvc).toMatchObject({
          executionProfile: 'full-playwright', status: 'failed', cleanupStatus: 'verified-clean',
          report: { content: { verdict: 'rejected' } },
        })
        return
      }

      if (result.doctor.ready !== true) {
        const blocked = Object.values(result.doctor.probes ?? {})
          .filter((probe): probe is { status: string; reasonCode?: string } => (
            typeof probe === 'object' && probe !== null && 'status' in probe
          ))
          .filter((probe) => probe.status !== 'passed')
          .map((probe) => probe.reasonCode ?? probe.status)
          .join(',')
        throw new Error(`E2E_RELEASE_ENVIRONMENT:E2E_RUNTIME_DOCTOR_NOT_READY:${blocked}`)
      }
      expect(result.packageSource).toBe(process.env.E2E_RUNTIME_GOLDEN_PACKAGE_SOURCE === 'registry'
        ? 'npm-registry' : 'workspace-tarballs')
      expect(result.verifiedPublishedPackages).toEqual(
        result.packageSource === 'npm-registry' ? publishedPackages : [],
      )
      expect(result.doctor).toMatchObject({
        browserSource: 'system-chrome', approvalMode: 'local-confirmation',
      })
      expect(result.managedBrowserInstalled).toBe(false)
      if (result.report.content.verdict !== 'accepted') {
        throw new Error(`E2E_RELEASE_BUSINESS:REPORT_VERDICT_${result.report.content.verdict}`)
      }
      expect(result.report.content.approvalAssurance).toEqual({
        approvalMode: 'local-confirmation',
        identityVerified: false,
        separationOfDutiesVerified: false,
      })
      expect(result.report.content.runtimeProvenance.sourceRepositoryIndependent).toBe(true)
      expect(result.publishedRegression).toMatchObject({ exitCode: 0 })
      expect(result.publishedRegression.gatewayAuditDigest).toMatch(/^sha256:/)
      if (result.fullPlaywright.status !== 'passed'
        || result.fullPlaywright.cleanupStatus !== 'verified-clean'
        || result.fullPlaywright.reloadVerified !== true
        || result.fullPlaywright.jsonBodyVerified !== true
        || result.fullPlaywright.report.content.verdict !== 'accepted') {
        throw new Error('E2E_RELEASE_BUSINESS:FULL_PLAYWRIGHT_NOT_ACCEPTED')
      }
      expect(result.fullPlaywright).toMatchObject({
        executionProfile: 'full-playwright', status: 'passed', cleanupStatus: 'verified-clean',
        reloadVerified: true, jsonBodyVerified: true,
        report: { content: { verdict: 'accepted' } },
      })
      expect(result.fullPlaywright.semanticReview.reviewDigest).toMatch(/^sha256:/)
      expect(result.fullPlaywright.semanticReview.prd.normalizedText).toContain('JSON Body')
      if (process.env.E2E_RUNTIME_RUN_TODOMVC_PUBLIC === '1') {
        expect(result.todoMvc).toMatchObject({
          executionProfile: 'full-playwright', status: 'failed', cleanupStatus: 'verified-clean',
          prdUrl: 'https://raw.githubusercontent.com/tastejs/todomvc/ff43b02e59dfa604386bb382034b2cd07c2bcd8a/app-spec.md',
          targetUrl: 'https://todomvc.com/examples/typescript-react/',
          report: { content: { verdict: 'rejected' } },
          tracePath: [
            'CLAUSE-TODOMVC-F20', 'REQ-TODOMVC-F20', 'RULE-TODOMVC-F20',
            'ORACLE-TODOMVC-F20', 'COV-REQ-TODOMVC-F20',
            'CASE-TODOMVC-FUNCTIONAL-1', 'ACTION-TODOMVC-FUNCTIONAL-1', 'rejected',
          ],
        })
        expect(result.todoMvc?.prdRevision).toMatch(/^sha256:/)
        expect(result.todoMvc?.semanticReview.reviewDigest).toMatch(/^sha256:/)
        expect(result.todoMvc?.semanticReview.prd.normalizedText).toContain('# Application Specification')
      }
      expect(result.tracePath).toEqual([
        'PRD-ORDER-1', 'REQ-ORDER-1', 'RULE-ORDER-1', 'COV-ORDER-1',
        'CASE-ORDER-1', 'ACTION-ORDER-1', 'EVIDENCE-ORDER-1', 'accepted',
      ])
      const published = await readdir(join(project, '.biztest'), { recursive: true })
      expect(published.some((path) => String(path).includes('quarantine'))).toBe(false)
      expect(await readFile(result.reportPath, 'utf8')).not.toContain(process.cwd())
      expect(await readFile(result.fullPlaywright.reportPath, 'utf8')).not.toContain(process.cwd())
      if (result.todoMvc) {
        expect(await readFile(result.todoMvc.reportPath, 'utf8')).not.toContain(process.cwd())
      }
    },
    1_200_000,
  )
})
