import { mkdir, readFile, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { canonicalizeJson, digestText } from '@mutil-skills/e2e-contracts'
import {
  LocalRegressionDiscoveryAuthority,
  createRegressionDiscoveryVerifier,
  projectCompilerInputFromArtifacts,
} from '../src/index.js'
import { approvedCompilerArtifacts, approvedCompilerArtifactsWithBlockedCase, approvedFullPlaywrightCompilerArtifacts,
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

  test('full Playwright profile 进入 Discovery subject 和完整 Source Set 证明', async () => {
    const authority = LocalRegressionDiscoveryAuthority.create({ issuer: 'DISCOVERY', keyId: 'DISCOVERY-1' })
    const result = await authority.compileAndAttest({
      tempParent: join(process.cwd(), '.tmp'),
      compilerInput: projectCompilerInputFromArtifacts({
        artifacts: approvedFullPlaywrightCompilerArtifacts(), playwrightVersion: '1.61.1',
        ...compilerArtifactVerification,
      }),
    })
    directories.push(result.projectDir)
    expect(result.subject.executionProfile).toBe('full-playwright')
    expect(result.subject.sourceSetDigest).toMatch(/^sha256:[a-f0-9]{64}$/)
    expect(result.subject.sourceFiles.map((file) => file.relativePath)).toEqual(expect.arrayContaining([
      'regression/fixtures/full-playwright-runtime.ts', 'regression/tests/generated.spec.ts',
    ]))
    expect(result.subject.templateDigest).toBe(digestText(
      'controlled-regression-template/full-playwright/v1', canonicalizeJson({
        version: '3.0.0', files: ['README.md', 'package.json', 'package-lock.json', 'playwright.config.ts',
          'fixtures/full-playwright-runtime.ts', 'tests/generated.spec.ts', 'run-bundle.json', 'safety-policy.json',
          'network-policy.json', 'evidence-policy.json', 'toolchain-manifest.json', 'template-manifest.json',
          'source-integrity.json'],
        executionProfile: 'full-playwright', actionKinds: ['fullPlaywright'],
        writeExecution: 'trusted-full-playwright-runtime',
      }),
    ))
    expect(createRegressionDiscoveryVerifier(authority.verifierMaterial,
      authority.verifierMaterial.publicKeyDigest)(result.attestation, result.subject)).toBe(true)
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

  test('Discovery 拒绝冻结 Compiler Input 的 Node 版本与实际可信工具链漂移', async () => {
    const authority = LocalRegressionDiscoveryAuthority.create({ issuer: 'DISCOVERY', keyId: 'DISCOVERY-1' })
    await expect(authority.compileAndAttest({ tempParent: join(process.cwd(), '.tmp'),
      compilerInput: projectCompilerInputFromArtifacts({
        artifacts: approvedCompilerArtifacts(), playwrightVersion: '1.61.1',
        ...compilerArtifactVerification, nodeVersion: '99.99.99',
      }),
    })).rejects.toThrow('E2E_REGRESSION_DISCOVERY_TOOLCHAIN_MISMATCH')
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
