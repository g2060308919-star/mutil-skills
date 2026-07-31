import { afterEach, describe, expect, test } from 'vitest'
import { access, lstat, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { StandaloneEvidencePublisher } from '../src/standalone-evidence-publisher.js'
import { digestText } from '@mutil-skills/e2e-contracts'

const roots: string[] = []
afterEach(async () => await Promise.all(roots.splice(0).map(async (root) =>
  await rm(root, { recursive: true, force: true }))))

describe('StandaloneEvidencePublisher', () => {
  test('publishes raw screenshot and Trace bytes unchanged outside Git', async () => {
    const root = await mkdtemp(join(tmpdir(), 'e2e-standalone-evidence-')); roots.push(root)
    const screenshot = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])
    const trace = Buffer.from([0x50, 0x4b, 0x03, 0x04, 4, 5, 6])
    const outputRoot = join(root, 'acceptance-result')
    const published = await new StandaloneEvidencePublisher({ homeDir: join(root, 'home') }).publish({
      assetId: 'ASSET-1', runId: 'RUN-1', generationDigest: `sha256:${'a'.repeat(64)}`,
      outputRoot,
      rendered: { json: '{"ok":true}', markdown: '# 验收', html: '<!doctype html><p>验收</p>' },
      evidence: [{
        caseId: 'CASE-1', checkpointId: 'CHECKPOINT-1', kind: 'screenshot',
        relativePath: 'evidence/CASE-1/CHECKPOINT-1.png', bytes: screenshot,
      }, {
        caseId: 'CASE-1', checkpointId: 'TRACE-1', kind: 'trace',
        relativePath: 'evidence/CASE-1/playwright-trace.zip', bytes: trace,
      }],
    })
    expect(published).toBe(outputRoot)
    expect(await readFile(join(published, 'evidence/CASE-1/CHECKPOINT-1.png'))).toEqual(screenshot)
    expect(await readFile(join(published, 'evidence/CASE-1/playwright-trace.zip'))).toEqual(trace)
    expect((await stat(published)).mode & 0o777).toBe(0o700)
    expect((await stat(join(published, 'evidence/CASE-1/CHECKPOINT-1.png'))).mode & 0o777).toBe(0o600)
    const manifest = JSON.parse(await readFile(join(published, 'manifest.json'), 'utf8'))
    expect(manifest.files).toMatchObject({
      'evidence/CASE-1/CHECKPOINT-1.png': {
        kind: 'screenshot', digest: expect.stringMatching(/^sha256:/), byteLength: screenshot.byteLength,
      },
      'evidence/CASE-1/playwright-trace.zip': {
        kind: 'trace', digest: expect.stringMatching(/^sha256:/), byteLength: trace.byteLength,
      },
    })
  })

  test('从 Runtime 状态目录发布生产截图、DOM 与 Playwright Trace', async () => {
    const root = await mkdtemp(join(tmpdir(), 'e2e-standalone-runtime-')); roots.push(root)
    const home = join(root, 'home')
    const publisher = new StandaloneEvidencePublisher({ homeDir: home })
    const attemptId = 'ATTEMPT-PRODUCTION-1'
    const stateRoot = join(home, '.mutil-skills', 'runtime', 'e2e', 'state')
    const recoveryDirectory = digestText(
      'runtime-full-playwright-recovery-directory/v1',
      attemptId,
    ).slice(7, 39)
    const recoveryRoot = join(stateRoot, 'full-playwright-recovery', recoveryDirectory)
    const traceRoot = join(stateRoot, 'full-playwright-traces', attemptId)
    const screenshot = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1])
    const dom = Buffer.from('<main>已验收</main>')
    const trace = Buffer.from([0x50, 0x4b, 0x03, 0x04, 1])
    await mkdir(recoveryRoot, { recursive: true, mode: 0o700 })
    await mkdir(traceRoot, { recursive: true, mode: 0o700 })
    await writeFile(join(recoveryRoot, 'screenshot.bin'), screenshot, { mode: 0o600 })
    await writeFile(join(recoveryRoot, 'dom.bin'), dom, { mode: 0o600 })
    await writeFile(join(traceRoot, 'program-after.zip'), trace, { mode: 0o600 })

    const published = await publisher.publishRuntimeState({
      assetId: 'ASSET-1',
      runId: 'RUN-1',
      generationDigest: `sha256:${'a'.repeat(64)}`,
      outputRoot: join(root, 'standalone-runtime-report'),
      rendered: { json: '{}', markdown: '# report', html: '<html></html>' },
      cases: [{ caseId: 'CASE-1', actionId: 'ACTION-1', attemptId }],
    })

    expect(await readFile(join(published, 'evidence/CASE-1/ACTION-1.png'))).toEqual(screenshot)
    expect(await readFile(join(published, 'evidence/CASE-1/ACTION-1.html'))).toEqual(dom)
    expect(await readFile(join(
      published,
      'evidence/CASE-1/trace-001-program-after.zip',
    ))).toEqual(trace)
  })

  test('uses the standalone HOME default and never requires a repository', async () => {
    const root = await mkdtemp(join(tmpdir(), 'e2e-standalone-default-')); roots.push(root)
    const homeDir = join(root, 'home')
    const published = await new StandaloneEvidencePublisher({ homeDir }).publish({
      assetId: 'ASSET-2', runId: 'RUN-2', generationDigest: `sha256:${'b'.repeat(64)}`,
      rendered: { json: '{}', markdown: '# 报告', html: '<!doctype html><p>报告</p>' },
      evidence: [],
    })
    expect(published).toBe(join(homeDir, '.mutil-skills/e2e/reports/ASSET-2/RUN-2'))
    await expect(access(join(published, 'final-report.html'))).resolves.toBeUndefined()
  })

  test('rejects traversal, malformed media, and symlinked output roots', async () => {
    const root = await mkdtemp(join(tmpdir(), 'e2e-standalone-safety-')); roots.push(root)
    const publisher = new StandaloneEvidencePublisher({ homeDir: join(root, 'home') })
    await expect(publisher.publish({
      ...baseInput(join(root, 'traversal')),
      evidence: [{ caseId: 'CASE-1', checkpointId: 'CHECKPOINT-1', kind: 'screenshot',
        relativePath: '../secret.png', bytes: Buffer.from('not-png') }],
    })).rejects.toMatchObject({ code: 'E2E_EVIDENCE_OUTPUT_PATH_INVALID' })

    await expect(publisher.publish({
      ...baseInput(join(root, 'bad-media')),
      evidence: [{ caseId: 'CASE-1', checkpointId: 'CHECKPOINT-1', kind: 'screenshot',
        relativePath: 'evidence/CASE-1/bad.png', bytes: Buffer.from('not-png') }],
    })).rejects.toMatchObject({ code: 'E2E_EVIDENCE_MEDIA_INVALID' })

    const real = join(root, 'real')
    await new StandaloneEvidencePublisher({ homeDir: join(root, 'home') }).publish({
      ...baseInput(real), evidence: [],
    })
    const alias = join(root, 'alias')
    await symlink(real, alias)
    expect((await lstat(alias)).isSymbolicLink()).toBe(true)
    await expect(publisher.publish({
      ...baseInput(alias), evidence: [],
    })).rejects.toMatchObject({ code: 'E2E_EVIDENCE_OUTPUT_ROOT_UNSAFE' })
  })
})

function baseInput(outputRoot: string) {
  return {
    assetId: 'ASSET-1', runId: 'RUN-1', generationDigest: `sha256:${'c'.repeat(64)}`,
    outputRoot,
    rendered: { json: '{}', markdown: '# 报告', html: '<!doctype html><p>报告</p>' },
  }
}
