import { readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import {
  LocalRegressionDiscoveryAuthority,
  createRegressionDiscoveryVerifier,
  projectCompilerInputFromArtifacts,
  prepareTrustedCompilerRun,
  getTrustedCompilerRunBinding,
  createTrustedCompilerControlledWriteLauncher,
  discardTrustedCompilerRun,
  executeTrustedCompilerProject,
  captureTrustedCompilerRuntimeMeasurement,
  inspectTrustedCompilerRuntimeMeasurement,
} from '../src/index.js'
import {
  approvedCompilerArtifacts,
  compilerArtifactVerification,
  createCompilerTestExecutionTrust,
} from './compiler-artifacts.fixture.js'

const directories: string[] = []

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

describe('可信 Compiler 执行前复验', () => {
  test('普通对象不能伪造 Host 执行前 Chrome/Proxy 测量能力', () => {
    expect(() => captureTrustedCompilerRuntimeMeasurement({} as never))
      .toThrow('E2E_TRUST_RUNTIME_MEASUREMENT_SOURCE_INVALID')
  })

  test('V2 签名与实际 Source Set 一致时创建不可伪造的 trusted-reversible-write 会话', async () => {
    const authority = LocalRegressionDiscoveryAuthority.create({ issuer: 'DISCOVERY', keyId: 'DISCOVERY-1' })
    const result = await authority.compileAndAttest({ tempParent: join(process.cwd(), '.tmp'),
      compilerInput: projectCompilerInputFromArtifacts({
        artifacts: approvedCompilerArtifacts({ effect: 'reversible-write' }), playwrightVersion: '1.61.1',
        ...compilerArtifactVerification,
      }) })
    directories.push(result.projectDir)
    const trust = await createCompilerTestExecutionTrust(authority.verifierMaterial)
    const measurement = inspectTrustedCompilerRuntimeMeasurement(captureTrustedCompilerRuntimeMeasurement(trust))
    expect(measurement).toMatchObject({
      browserExecutableDigest: expect.stringMatching(/^sha256:/),
      gatewayProxyEndpointDigest: expect.stringMatching(/^sha256:/),
    })
    const session = await prepareTrustedCompilerRun({ projectDir: result.projectDir,
      subject: result.subject, attestation: result.attestation,
      trust,
      expected: { assetId: result.subject.assetId, generationId: result.subject.generationId,
        prdRevision: result.subject.prdRevision, runId: 'RUN-1', approvalDigest: result.subject.approvalDigest,
        executionProfile: 'trusted-reversible-write' }, authorityTransport: 'in-process-test' })
    expect(getTrustedCompilerRunBinding(session)).toMatchObject({
      testDomain: 'prd-e2e-trusted-compiler', executionProfile: 'trusted-reversible-write', runId: 'RUN-1',
      caseIds: ['CASE-WRITE-1'], actionIds: ['ACTION-WRITE-1'],
      caseActions: [{ caseId: 'CASE-WRITE-1', actionIds: ['ACTION-WRITE-1'] }],
    })
    expect(() => createTrustedCompilerControlledWriteLauncher([], {} as never, session))
      .toThrow('E2E_CONTROLLED_WRITE_ACTIONS_EMPTY')
    expect(() => createTrustedCompilerControlledWriteLauncher([], {} as never, session))
      .toThrow('E2E_CONTROLLED_WRITE_TRUSTED_COMPILER_SESSION_ALREADY_CLAIMED')
    await expect(executeTrustedCompilerProject({
      session, writeBridge: Object.freeze({ close: async () => undefined }),
    })).rejects.toThrow('E2E_RUN_ENVIRONMENT_INVALID')
    await discardTrustedCompilerRun(session)
  })

  test('Discovery 后修改任意源码 bytes，在 launcher 前 fail closed', async () => {
    const authority = LocalRegressionDiscoveryAuthority.create({ issuer: 'DISCOVERY', keyId: 'DISCOVERY-1' })
    const result = await authority.compileAndAttest({ tempParent: join(process.cwd(), '.tmp'),
      compilerInput: projectCompilerInputFromArtifacts({
        artifacts: approvedCompilerArtifacts(), playwrightVersion: '1.61.1', ...compilerArtifactVerification,
      }) })
    directories.push(result.projectDir)
    const specPath = join(result.projectDir, 'tests/generated.spec.ts')
    const source = await readFile(specPath, 'utf8')
    await writeFile(specPath, `${source}\n// tampered`)
    const trust = await createCompilerTestExecutionTrust(authority.verifierMaterial)
    await expect(prepareTrustedCompilerRun({ projectDir: result.projectDir,
      subject: result.subject, attestation: result.attestation,
      trust,
      expected: { assetId: result.subject.assetId, generationId: result.subject.generationId,
        prdRevision: result.subject.prdRevision, runId: 'RUN-1', approvalDigest: result.subject.approvalDigest,
        executionProfile: 'trusted-read-only' }, authorityTransport: 'in-process-test' }))
      .rejects.toThrow('E2E_RUN_SOURCE_CHANGED')
  })

  test('RUN-1 的已审批 Run Bundle 不能启动调用方指定的 RUN-2', async () => {
    const authority = LocalRegressionDiscoveryAuthority.create({ issuer: 'DISCOVERY', keyId: 'DISCOVERY-1' })
    const result = await authority.compileAndAttest({ tempParent: join(process.cwd(), '.tmp'),
      compilerInput: projectCompilerInputFromArtifacts({
        artifacts: approvedCompilerArtifacts(), playwrightVersion: '1.61.1', ...compilerArtifactVerification,
      }) })
    directories.push(result.projectDir)
    const trust = await createCompilerTestExecutionTrust(authority.verifierMaterial)
    await expect(prepareTrustedCompilerRun({ projectDir: result.projectDir,
      subject: result.subject, attestation: result.attestation, trust,
      expected: { assetId: result.subject.assetId, generationId: result.subject.generationId,
        prdRevision: result.subject.prdRevision, runId: 'RUN-2', approvalDigest: result.subject.approvalDigest,
        executionProfile: 'trusted-read-only' }, authorityTransport: 'in-process-test' }))
      .rejects.toThrow('E2E_RUN_BINDING_MISMATCH')
  })

  test('普通对象不能伪造 trusted Compiler launcher 会话', () => {
    expect(() => createTrustedCompilerControlledWriteLauncher([], {} as never, {} as never))
      .toThrow('E2E_CONTROLLED_WRITE_TRUSTED_COMPILER_SESSION_REQUIRED')
  })

  test('调用方不能用伪造签名绕过固定 Discovery 验签器', async () => {
    const authority = LocalRegressionDiscoveryAuthority.create({ issuer: 'DISCOVERY', keyId: 'DISCOVERY-1' })
    const result = await authority.compileAndAttest({ tempParent: join(process.cwd(), '.tmp'),
      compilerInput: projectCompilerInputFromArtifacts({
        artifacts: approvedCompilerArtifacts({ effect: 'reversible-write' }), playwrightVersion: '1.61.1',
        ...compilerArtifactVerification,
      }) })
    directories.push(result.projectDir)
    const trust = await createCompilerTestExecutionTrust(authority.verifierMaterial)
    await expect(prepareTrustedCompilerRun({ projectDir: result.projectDir,
      subject: result.subject, attestation: { ...result.attestation, signature: 'forged' },
      trust,
      expected: { assetId: result.subject.assetId, generationId: result.subject.generationId,
        prdRevision: result.subject.prdRevision, runId: 'RUN-1', approvalDigest: result.subject.approvalDigest,
        executionProfile: 'trusted-reversible-write' }, authorityTransport: 'in-process-test' }))
      .rejects.toThrow('E2E_RUN_ATTESTATION_INVALID')
  })
})
