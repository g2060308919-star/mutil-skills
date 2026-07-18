import { rm } from 'node:fs/promises'
import {
  LocalRegressionDiscoveryAuthority,
  type CompileAndAttestRegressionResult,
  type TrustedCompilerInput,
} from '@mutil-skills/e2e-playwright-runtime'
import { E2EError, type RegressionDiscoveryAttestation,
  type RegressionDiscoveryVerifierMaterial } from '@mutil-skills/e2e-contracts'
import { SandboxedOneShotExecutor } from './sandboxed-one-shot-executor.js'

export interface RegressionPublicationResult {
  compilerInputDigest: string
  sourceSetDigest: string
  discoveryAttestation: RegressionDiscoveryAttestation
  caseIds: string[]
  files: Array<{ relativePath: string; bytes: Uint8Array }>
  isolationProof: {
    backend: 'macos-sandbox-exec' | 'linux-bwrap'
    proofDigest: string
  }
  verifierMaterial?: RegressionDiscoveryVerifierMaterial
}

interface RegressionDiscoveryCompiler {
  readonly verifierMaterial?: RegressionDiscoveryVerifierMaterial
  compileAndAttest(input: {
    tempParent: string
    compilerInput: TrustedCompilerInput
  }): Promise<CompileAndAttestRegressionResult>
}

export class RegressionPublisher {
  private constructor(
    private readonly authority: RegressionDiscoveryCompiler,
    private readonly tempParent: string,
  ) {}

  static async create(input: {
    issuer: string
    keyId: string
    tempParent: string
  }): Promise<RegressionPublisher> {
    const executor = await SandboxedOneShotExecutor.create({ tempParent: input.tempParent })
    return new RegressionPublisher(LocalRegressionDiscoveryAuthority.create({
      issuer: input.issuer,
      keyId: input.keyId,
      sandboxExecutor: executor,
    }), input.tempParent)
  }

  static createForTesting(input: {
    authority: RegressionDiscoveryCompiler
    tempParent: string
  }): RegressionPublisher {
    return new RegressionPublisher(input.authority, input.tempParent)
  }

  async compile(input: { compilerInput: TrustedCompilerInput }): Promise<RegressionPublicationResult> {
    if (!input || Object.keys(input).join('\0') !== 'compilerInput') throw publisherError(
      'E2E_REGRESSION_PUBLICATION_INPUT_INVALID', 'Regression Publisher 只接受可信 CompilerInput',
    )
    let result: CompileAndAttestRegressionResult | undefined
    try {
      result = await this.authority.compileAndAttest({
        compilerInput: input.compilerInput,
        tempParent: this.tempParent,
      })
      if (result.isolationProof === undefined) throw publisherError(
        'E2E_REGRESSION_PUBLICATION_SANDBOX_PROOF_MISSING', 'Regression discovery 缺少实际 OS 沙箱证明',
      )
      const verifierMaterial = this.authority.verifierMaterial
      return {
        compilerInputDigest: result.attestation.compilerInputDigest,
        sourceSetDigest: result.attestation.sourceSetDigest,
        discoveryAttestation: result.attestation,
        caseIds: [...result.attestation.discoveredCaseIds],
        files: result.files.map(({ relativePath, bytes }) => ({ relativePath, bytes: Buffer.from(bytes) })),
        isolationProof: { ...result.isolationProof },
        ...(verifierMaterial === undefined ? {} : { verifierMaterial: structuredClone(verifierMaterial) }),
      }
    } finally {
      if (result !== undefined) await rm(result.projectDir, { recursive: true, force: true })
    }
  }
}

function publisherError(code: string, message: string): E2EError {
  return new E2EError({ code, category: 'safety', message, retryable: false })
}
