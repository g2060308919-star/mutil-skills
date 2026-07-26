import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { Readable, Writable } from 'node:stream'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { buildCompleteGeneration, createWorkflow, PatternPrivacyScanner } from '@mutil-skills/e2e-engine'
import { canonicalizeJson, digestText } from '@mutil-skills/e2e-contracts'
import { completeGenerationFixture } from '../../e2e-engine/test/complete-generation.fixture.js'
import { createArtifactStoreAuthority } from '../../e2e-engine/test/artifact-store-authority.js'
import { ProjectPublisher } from '../src/project-publisher.js'
import { openRuntimeArtifactStoreAuthority } from '../src/authority-host.js'
import { RuntimeRunStore } from '../src/run-store.js'
import { resolveProjectIdentity } from '../src/project-identity.js'
import { runCli } from '../src/cli.js'

const roots: string[] = []
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))))

describe('ProjectPublisher', () => {
  test('真实 repo-e2e report 使用持久 Authority 验签且只读取 active generation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'e2e-project-report-cli-')); roots.push(root)
    const homeDir = join(root, 'home')
    const projectRoot = join(root, 'project')
    const versionRoot = join(root, 'runtime-version')
    await Promise.all([
      mkdir(homeDir, { recursive: true }), mkdir(projectRoot, { recursive: true }),
      mkdir(versionRoot, { recursive: true }), mkdir(join(projectRoot, '.biztest'), { recursive: true }),
    ])
    await writeFile(join(projectRoot, '.biztest/project.json'), JSON.stringify({
      schemaVersion: '1.0.0', projectId: 'PROJECT-CLI-REPORT',
    }))
    const identity = await resolveProjectIdentity(projectRoot)
    const installation = {
      version: '0.0.0', protocolMajor: 1 as const, versionRoot,
      entrypoint: join(versionRoot, 'runtime-host.js'),
      installationDigest: digestText('test-installation/v1', 'report-cli'),
      sourceRepositoryIndependent: true as const,
    }
    const subject = `local:uid:${process.getuid!()}`
    const artifactAuthority = await openRuntimeArtifactStoreAuthority({ homeDir, installation, subject })
    const fixture = completeGenerationFixture()
    fixture.provenance.projectIdentityDigest = identity.digest
    const publisher = new ProjectPublisher({
      projectRoot, scanner: new PatternPrivacyScanner('0.1.0'), authority: artifactAuthority,
    })
    await publisher.publish({ assetId: fixture.context.assetId, generationId: fixture.context.generationId,
      prepare: ({ fencingToken }) => {
        fixture.context.fencingToken = fencingToken
        return buildCompleteGeneration(fixture)
      },
    })
    await artifactAuthority.close()

    // staging 中的伪报告不得影响 CLI；读取路径只能来自已验签 active pointer。
    await mkdir(join(projectRoot, '.biztest/staging/GEN-FAKE/run'), { recursive: true })
    await writeFile(join(projectRoot, '.biztest/staging/GEN-FAKE/run/final-report.json'), '{"forged":true}')
    const store = await RuntimeRunStore.open({ homeDir, projectRoot })
    const seedRequestId = 'SEED-CLI-REPORT-RUN'
    const seedDigest = digestText('test-request/v1', seedRequestId)
    await store.beginRequest(seedRequestId, seedDigest)
    const lock = await store.acquireRunLock(identity.digest, fixture.context.generationId)
    await store.createRunOutcome({
      schemaVersion: '1.2.0', runId: fixture.context.generationId, assetId: fixture.context.assetId,
      projectIdentityDigest: identity.digest,
      runtimeInstallationDigest: installation.installationDigest,
      runRevision: 0, workflow: createWorkflow(),
      artifactDigests: { 'prd-source': fixture.context.prdRevision },
      frozenArtifacts: {}, trustedExecutionFacts: {}, writeAttempts: {},
      executionResults: { realEnvironment: {}, gatewayInjection: {} },
      requestResponses: {}, createdAt: fixture.context.createdAt, updatedAt: fixture.context.createdAt,
    }, seedRequestId, seedDigest, { seeded: true }, lock)
    await lock.close()
    await store.close()

    const stdout = captureWritable()
    const stderr = captureWritable()
    const exitCode = await runCli(
      ['report', '--run-id', fixture.context.generationId], Readable.from([]), stdout.stream, stderr.stream,
      {
        homeDir,
        installRuntime: async () => ({ version: '0.0.0', installationDigest: installation.installationDigest,
          launcher: '/unused' }),
        uninstallRuntime: async () => ({ version: '0.0.0' }),
        inspectRuntimeInstallation: async () => installation,
        runRuntimeDoctor: async () => ({ ready: true, runtimeVersion: '0.0.0',
          installationDigest: installation.installationDigest,
          browserSource: 'system-chrome', approvalMode: 'local-confirmation', probes: {} }),
        currentWorkingDirectory: () => projectRoot,
      },
    )
    expect(exitCode).toBe(0)
    const response = JSON.parse(stdout.text())
    expect(response).toMatchObject({
      ok: true,
      result: {
        generationId: fixture.context.generationId,
        report: { markdown: expect.stringContaining('Runtime 与隔离证明') },
      },
    })
    expect(canonicalizeJson(response)).not.toContain('forged')
    expect(stderr.text()).toBe('')
  })

  test('固定发布到 project/.biztest，staged audit 后复读 active digest，报告只读 active generation', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'e2e-project-publisher-')); roots.push(projectRoot)
    const authority = createArtifactStoreAuthority()
    const publisher = new ProjectPublisher({
      projectRoot, scanner: new PatternPrivacyScanner('1.0.0'),
      authority: { signDigest: authority.signDigest, verifySignature: authority.verifySignature },
    })
    const active = await publisher.publish({ assetId: 'ASSET-1', generationId: 'GEN-1',
      prepare: ({ fencingToken }) => {
        const fixture = completeGenerationFixture(); fixture.context.fencingToken = fencingToken
        return buildCompleteGeneration(fixture)
      },
    })
    expect(active.generationPath).toBe(join(
      await realpath(projectRoot), '.biztest', 'assets', 'ASSET-1', 'generations', 'GEN-1',
    ))
    expect(active.generationPath).not.toContain(join('.biztest', '.biztest'))
    expect(JSON.parse(await readFile(join(active.generationPath, 'run/final-report.json'), 'utf8')))
      .toMatchObject({ schemaVersion: '3.0.0' })
    const rendered = await publisher.renderActiveReport({
      assetId: 'ASSET-1',
      expectedGenerationId: 'GEN-1',
      expectedProjectIdentityDigest: completeGenerationFixture().provenance.projectIdentityDigest,
    })
    expect(rendered).toMatchObject({
      active: {
        generationId: 'GEN-1',
        generationDigest: expect.stringMatching(/^sha256:/),
      },
      rendered: { markdown: expect.stringContaining('Runtime 与隔离证明') },
    })
    const reportRoot = join(projectRoot, '.biztest', 'reports', 'ASSET-1', 'GEN-1')
    expect(await readFile(join(reportRoot, 'final-report.json'), 'utf8')).toBe(rendered.rendered.json)
    expect(await readFile(join(reportRoot, 'final-report.md'), 'utf8')).toBe(rendered.rendered.markdown)
    expect(await readFile(join(reportRoot, 'final-report.html'), 'utf8')).toBe(rendered.rendered.html)
    expect(JSON.parse(await readFile(join(reportRoot, 'manifest.json'), 'utf8'))).toMatchObject({
      schemaVersion: '1.0.0', assetId: 'ASSET-1', generationId: 'GEN-1',
      generationDigest: active.generationDigest,
      files: {
        json: { path: 'final-report.json', digest: expect.stringMatching(/^sha256:/) },
        markdown: { path: 'final-report.md', digest: expect.stringMatching(/^sha256:/) },
        html: { path: 'final-report.html', digest: expect.stringMatching(/^sha256:/) },
      },
    })
    await expect(publisher.renderActiveReport({
      assetId: 'ASSET-1',
      expectedGenerationId: 'GEN-OTHER',
      expectedProjectIdentityDigest: completeGenerationFixture().provenance.projectIdentityDigest,
    })).rejects.toMatchObject({ code: 'E2E_PROJECT_ACTIVE_GENERATION_MISMATCH' })
  })

  test('项目 .biztest 出现 quarantine material 时发布前阻塞', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'e2e-project-publisher-')); roots.push(projectRoot)
    await mkdir(join(projectRoot, '.biztest'), { recursive: true })
    await writeFile(join(projectRoot, '.biztest', 'quarantine'), 'raw secret')
    const authority = createArtifactStoreAuthority()
    const publisher = new ProjectPublisher({ projectRoot, scanner: new PatternPrivacyScanner('1.0.0'),
      authority: { signDigest: authority.signDigest, verifySignature: authority.verifySignature } })
    await expect(publisher.publish({ assetId: 'ASSET-1', generationId: 'GEN-1',
      prepare: () => { throw new Error('must not prepare') },
    })).rejects.toMatchObject({ code: 'E2E_PROJECT_QUARANTINE_MATERIAL_DETECTED' })
  })
})

function captureWritable(): { stream: Writable; text(): string } {
  const chunks: Buffer[] = []
  return {
    stream: new Writable({ write(chunk, _encoding, callback) { chunks.push(Buffer.from(chunk)); callback() } }),
    text: () => Buffer.concat(chunks).toString('utf8'),
  }
}
