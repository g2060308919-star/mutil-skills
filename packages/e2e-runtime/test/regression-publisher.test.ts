import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test, vi } from 'vitest'
import {
  LocalRegressionDiscoveryAuthority,
  projectCompilerInputFromArtifacts,
  type RegressionDiscoverySandboxExecutor,
} from '@mutil-skills/e2e-playwright-runtime'
import {
  approvedCompilerArtifacts,
  compilerArtifactVerification,
} from '../../e2e-playwright-runtime/test/compiler-artifacts.fixture.js'
import { RegressionPublisher } from '../src/regression-publisher.js'

const roots: string[] = []
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))))

describe('RegressionPublisher', () => {
  test('只发布受信编译输出，并要求 discovery 来自实际 OS sandbox proof', async () => {
    const tempParent = await mkdtemp(join(tmpdir(), 'e2e-regression-publisher-')); roots.push(tempParent)
    const execute = vi.fn<RegressionDiscoverySandboxExecutor['execute']>(async () => ({
      backend: 'macos-sandbox-exec',
      stdout: JSON.stringify({ suites: [{ title: 'CASE-READ-1 读取订单', tests: [] }] }),
      stderr: '', exitCode: 0, proofDigest: `sha256:${'a'.repeat(64)}`,
    }))
    const authority = LocalRegressionDiscoveryAuthority.create({
      issuer: 'DISCOVERY', keyId: 'DISCOVERY-1', sandboxExecutor: { execute },
    })
    const publisher = RegressionPublisher.createForTesting({ authority, tempParent })
    const result = await publisher.compile({ compilerInput: projectCompilerInputFromArtifacts({
      artifacts: approvedCompilerArtifacts(), playwrightVersion: '1.61.1', ...compilerArtifactVerification,
    }) })

    expect(result.caseIds).toEqual(['CASE-READ-1'])
    expect(result.files.some((file) => file.relativePath === 'regression/tests/generated.spec.ts')).toBe(true)
    expect(result.isolationProof).toEqual({ backend: 'macos-sandbox-exec', proofDigest: `sha256:${'a'.repeat(64)}` })
    expect(execute).toHaveBeenCalledWith(expect.objectContaining({
      args: expect.arrayContaining(['test', '--list', '--reporter=json']),
      readOnlyRoots: expect.arrayContaining([expect.stringContaining('e2e-regression-discovery-')]),
    }))
    expect(await readdir(tempParent)).toEqual([])
  })

  test('没有实际 sandbox proof 时 fail closed 且清理 staging', async () => {
    const tempParent = await mkdtemp(join(tmpdir(), 'e2e-regression-publisher-')); roots.push(tempParent)
    const compilerInput = projectCompilerInputFromArtifacts({
      artifacts: approvedCompilerArtifacts(), playwrightVersion: '1.61.1', ...compilerArtifactVerification,
    })
    const authority = LocalRegressionDiscoveryAuthority.create({
      issuer: 'DISCOVERY', keyId: 'DISCOVERY-1', sandboxExecutor: { execute: async () => ({
        backend: 'linux-bwrap',
        stdout: JSON.stringify({ suites: [{ title: 'CASE-READ-1 读取订单', tests: [] }] }),
        stderr: '', exitCode: 0, proofDigest: `sha256:${'b'.repeat(64)}`,
      }) },
    })
    const compiled = await authority.compileAndAttest({ compilerInput, tempParent })
    const { isolationProof: _omitted, ...withoutProof } = compiled
    const publisher = RegressionPublisher.createForTesting({
      authority: { compileAndAttest: async () => withoutProof }, tempParent,
    })
    await expect(publisher.compile({ compilerInput }))
      .rejects.toMatchObject({ code: 'E2E_REGRESSION_PUBLICATION_SANDBOX_PROOF_MISSING' })
    expect(await readdir(tempParent)).toEqual([])
  })
})
