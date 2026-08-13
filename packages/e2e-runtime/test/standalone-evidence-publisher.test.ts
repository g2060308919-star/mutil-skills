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
      rendered: {
        json: '{"ok":true}', markdown: '# 验收', html: '<!doctype html><p>验收</p>',
        explanation: {
          json: '{"schemaVersion":"execution-explanation/v1"}',
          markdown: '# 执行解释',
          html: '<!doctype html><p>执行解释</p>',
        },
      },
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
    const html = await readFile(join(published, 'final-report.html'), 'utf8')
    expect(html).toContain('<img src="evidence/CASE-1/CHECKPOINT-1.png"')
    expect(html).toContain('href="evidence/CASE-1/playwright-trace.zip"')
    const markdown = await readFile(join(published, 'final-report.md'), 'utf8')
    expect(markdown).toContain('![CASE-1 / CHECKPOINT-1](evidence/CASE-1/CHECKPOINT-1.png)')
    expect(markdown).toContain('[下载 Trace](evidence/CASE-1/playwright-trace.zip)')
    expect(await readFile(join(published, 'execution-explanation.json'), 'utf8'))
      .toContain('execution-explanation/v1')
    expect(await readFile(join(published, 'execution-explanation.md'), 'utf8')).toBe('# 执行解释')
    expect(await readFile(join(published, 'execution-explanation.html'), 'utf8'))
      .toContain('执行解释')
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
      'execution-explanation.json': {
        kind: 'explanation-json', digest: expect.stringMatching(/^sha256:/),
      },
    })
  })

  test('从 Runtime 状态目录发布生产截图与 Playwright Trace，但不发布原始 DOM', async () => {
    const root = await mkdtemp(join(tmpdir(), 'e2e-standalone-runtime-')); roots.push(root)
    const home = join(root, 'home')
    const publisher = new StandaloneEvidencePublisher({ homeDir: home })
    const attemptId = 'ATTEMPT-PRODUCTION-1'
    const stateRoot = join(home, '.mutil-skills', 'e2e', 'state')
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
    await expect(access(join(published, 'evidence/CASE-1/ACTION-1.html'))).rejects.toMatchObject({
      code: 'ENOENT',
    })
    expect(await readFile(join(
      published,
      'evidence/CASE-1/trace-001-program-after.zip',
    ))).toEqual(trace)
  })

  test('独立报告将未发布的 DOM 证据链接降级为说明文本', async () => {
    const root = await mkdtemp(join(tmpdir(), 'e2e-standalone-dom-link-')); roots.push(root)
    const outputRoot = join(root, 'report')
    const publisher = new StandaloneEvidencePublisher({ homeDir: join(root, 'home') })
    const domPath = 'evidence/ACTION-1.dom.json'

    const published = await publisher.publish({
      assetId: 'ASSET-1', runId: 'RUN-1', generationDigest: `sha256:${'a'.repeat(64)}`,
      outputRoot,
      rendered: {
        json: `${JSON.stringify({ evidencePath: domPath })}\n`,
        markdown: `| EVIDENCE |\n| --- |\n| [EVIDENCE-1](<${domPath}>) |\n`,
        html: `<html><body><a href="${domPath}">EVIDENCE-1</a></body></html>`,
      },
      evidence: [],
    })

    const html = await readFile(join(published, 'final-report.html'), 'utf8')
    expect(html).not.toContain(`href="${domPath}"`)
    expect(html).toContain('EVIDENCE-1（原始 DOM 未在独立报告中发布）')
    const markdown = await readFile(join(published, 'final-report.md'), 'utf8')
    expect(markdown).not.toContain(`](<${domPath}>)`)
    expect(markdown).toContain('EVIDENCE-1（原始 DOM 未在独立报告中发布）')
    expect(await readFile(join(published, 'final-report.json'), 'utf8')).toContain(domPath)
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

  test('幂等重放会复验全部已发布文件，拒绝 manifest 未变但证据已被替换', async () => {
    const root = await mkdtemp(join(tmpdir(), 'e2e-standalone-replay-')); roots.push(root)
    const outputRoot = join(root, 'report')
    const publisher = new StandaloneEvidencePublisher({ homeDir: join(root, 'home') })
    const input = {
      ...baseInput(outputRoot),
      evidence: [{
        caseId: 'CASE-1', checkpointId: 'CHECKPOINT-1', kind: 'screenshot' as const,
        relativePath: 'evidence/CASE-1/CHECKPOINT-1.png',
        bytes: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1]),
      }],
    }
    await publisher.publish(input)
    await writeFile(
      join(outputRoot, 'evidence/CASE-1/CHECKPOINT-1.png'),
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 2]),
    )
    await expect(publisher.publish(input)).rejects.toMatchObject({
      code: 'E2E_EVIDENCE_OUTPUT_INTEGRITY_INVALID',
    })
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
