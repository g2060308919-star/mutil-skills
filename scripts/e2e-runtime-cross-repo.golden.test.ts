import { existsSync } from 'node:fs'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { runCrossRepoRuntimeGolden } from './e2e-runtime-cross-repo.js'

const roots: string[] = []
const crossRepoRequested = process.env.E2E_RUNTIME_RUN_CROSS_REPO === '1'
const systemChromeExecutable = process.env.E2E_RUNTIME_SYSTEM_CHROME_EXECUTABLE
  ?? (process.platform === 'darwin'
    ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
    : '/usr/bin/google-chrome-stable')
const runRealGolden = crossRepoRequested && existsSync(systemChromeExecutable)

afterEach(async () => {
  await Promise.all(roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true })))
})

describe('portable E2E runtime', () => {
  test.runIf(crossRepoRequested && !runRealGolden)(
    '发行门禁要求本机存在受支持的系统 Google Chrome',
    () => { throw new Error('E2E_RUNTIME_SYSTEM_CHROME_REQUIRED') },
  )
  test.skipIf(!runRealGolden)(
    'runs from packed artifacts in a blank project without source paths',
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'mutil-e2e-cross-repo-'))
      roots.push(root)
      const home = join(root, 'home')
      const project = join(root, 'user-project')
      const packs = join(root, 'packs')
      const result = await runCrossRepoRuntimeGolden({ home, project, packs })

      expect(result.doctor.ready).toBe(true)
      expect(result.doctor).toMatchObject({
        browserSource: 'system-chrome', approvalMode: 'local-confirmation',
      })
      expect(result.managedBrowserInstalled).toBe(false)
      expect(result.report.content.verdict).toBe('accepted')
      expect(result.report.content.approvalAssurance).toEqual({
        approvalMode: 'local-confirmation',
        identityVerified: false,
        separationOfDutiesVerified: false,
      })
      expect(result.report.content.runtimeProvenance.sourceRepositoryIndependent).toBe(true)
      expect(result.publishedRegression).toMatchObject({ exitCode: 0 })
      expect(result.publishedRegression.gatewayAuditDigest).toMatch(/^sha256:/)
      expect(result.tracePath).toEqual([
        'PRD-ORDER-1', 'REQ-ORDER-1', 'RULE-ORDER-1', 'COV-ORDER-1',
        'CASE-ORDER-1', 'ACTION-ORDER-1', 'EVIDENCE-ORDER-1', 'accepted',
      ])
      const published = await readdir(join(project, '.biztest'), { recursive: true })
      expect(published.some((path) => String(path).includes('quarantine'))).toBe(false)
      expect(await readFile(result.reportPath, 'utf8')).not.toContain(process.cwd())
    },
    420_000,
  )
})
