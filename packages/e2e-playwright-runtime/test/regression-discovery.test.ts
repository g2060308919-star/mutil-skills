import { mkdir, readFile, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import {
  LocalRegressionDiscoveryAuthority,
  createRegressionDiscoveryVerifier,
  projectCompilerInputFromArtifacts,
} from '../src/index.js'
import { approvedCompilerArtifacts, approvedCompilerArtifactsWithBlockedCase,
  compilerArtifactVerification } from './compiler-artifacts.fixture.js'

const directories: string[] = []

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

describe('可信回归 discovery', () => {
  test('只从受信 compiler 输出运行本地隔离 Playwright --list 并签发事实', async () => {
    const authority = LocalRegressionDiscoveryAuthority.create({ issuer: 'DISCOVERY', keyId: 'DISCOVERY-1' })
    const result = await authority.compileAndAttest({
      tempParent: join(process.cwd(), '.tmp'),
      compilerInput: projectCompilerInputFromArtifacts({
        artifacts: approvedCompilerArtifacts(), playwrightVersion: '1.61.1', ...compilerArtifactVerification,
      }),
    })
    directories.push(result.projectDir)

    expect(result.attestation.discoveredCaseIds).toEqual(['CASE-READ-1'])
    expect(result.attestation.caseMappings).toEqual([{ caseId: 'CASE-READ-1',
      relativePath: 'regression/tests/generated.spec.ts', testTitle: '读取订单' }])
    expect(result.attestation).toMatchObject({ schemaVersion: '2.0.0',
      testDomain: 'prd-e2e-trusted-compiler', executionProfile: 'trusted-read-only',
      purpose: 'regression-discovery-attestation/v2' })
    expect(result.attestation.sourceFiles.map((file) => file.relativePath)).toEqual([
      'regression/evidence-policy.json', 'regression/fixtures/safe-page.ts',
      'regression/network-policy.json', 'regression/package-lock.json', 'regression/package.json',
      'regression/playwright.config.ts', 'regression/README.md', 'regression/run-bundle.json', 'regression/safety-policy.json',
      'regression/source-integrity.json', 'regression/template-manifest.json',
      'regression/tests/generated.spec.ts', 'regression/toolchain-manifest.json',
    ])
    const spec = await readFile(join(result.projectDir, 'tests/generated.spec.ts'))
    expect(result.files.find((file) => file.relativePath === 'regression/tests/generated.spec.ts')?.bytes).toEqual(spec)
    const verifier = createRegressionDiscoveryVerifier(authority.verifierMaterial,
      authority.verifierMaterial.publicKeyDigest)
    expect(verifier(result.attestation, result.subject)).toBe(true)
    expect(verifier({ ...result.attestation, discoveredCaseIds: ['CASE-FAKE'] }, result.subject)).toBe(false)
  })

  test('API 不接受 caller source bytes 或 playwrightCaseIds', async () => {
    const authority = LocalRegressionDiscoveryAuthority.create({ issuer: 'DISCOVERY', keyId: 'DISCOVERY-1' })
    await expect(authority.compileAndAttest({
      tempParent: join(process.cwd(), '.tmp'),
      compilerInput: projectCompilerInputFromArtifacts({
        artifacts: approvedCompilerArtifacts(), playwrightVersion: '1.61.1', ...compilerArtifactVerification,
      }),
      sourceFiles: [{ relativePath: 'tests/evil.spec.ts', bytes: 'process.exit(0)' }],
      playwrightCaseIds: ['CASE-FAKE'],
    } as any)).rejects.toThrow('E2E_REGRESSION_DISCOVERY_INPUT_INVALID')
  })

  test('list/工具链失败时自动清理隔离目录', async () => {
    const parent = join(process.cwd(), '.tmp', `e2e-discovery-cleanup-${Date.now()}`)
    directories.push(parent)
    await mkdir(parent, { recursive: true })
    const authority = LocalRegressionDiscoveryAuthority.create({ issuer: 'DISCOVERY', keyId: 'DISCOVERY-1' })
    await expect(authority.compileAndAttest({ tempParent: parent,
      compilerInput: projectCompilerInputFromArtifacts({
        artifacts: approvedCompilerArtifacts(), playwrightVersion: '1.0.0', ...compilerArtifactVerification,
      }),
    })).rejects.toThrow('E2E_REGRESSION_DISCOVERY_TOOLCHAIN_MISMATCH')
    expect(await readdir(parent)).toEqual([])
  })

  test('Discovery 签名证明 blocked Case 未进入源码、mapping 和 playwright --list', async () => {
    const authority = LocalRegressionDiscoveryAuthority.create({ issuer: 'DISCOVERY', keyId: 'DISCOVERY-1' })
    const result = await authority.compileAndAttest({
      tempParent: join(process.cwd(), '.tmp'),
      compilerInput: projectCompilerInputFromArtifacts({
        artifacts: approvedCompilerArtifactsWithBlockedCase(), playwrightVersion: '1.61.1',
        ...compilerArtifactVerification,
      }),
    })
    directories.push(result.projectDir)
    expect(result.attestation.blockedCases).toEqual([
      { caseId: 'CASE-BLOCKED', reasonCode: 'E2E_COMPILER_ACTION_UNSUPPORTED' },
    ])
    expect(result.attestation.discoveredCaseIds).toEqual(['CASE-READ-1'])
    expect(result.attestation.caseMappings.map((item) => item.caseId)).toEqual(['CASE-READ-1'])
    const spec = await readFile(join(result.projectDir, 'tests/generated.spec.ts'), 'utf8')
    expect(spec).not.toContain('CASE-BLOCKED')
    expect(spec).not.toMatch(/\btest\s*\.\s*(?:skip|fixme|fail|only|todo)|\btest\s*\.\s*describe\s*\.\s*(?:skip|fixme|only)/)
    expect(createRegressionDiscoveryVerifier(authority.verifierMaterial,
      authority.verifierMaterial.publicKeyDigest)(result.attestation, result.subject)).toBe(true)
  })
})
