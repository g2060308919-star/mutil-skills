import { E2EError, digestBytes } from '@mutil-skills/e2e-contracts'
import {
  validateGeneration,
  type ValidateGenerationInput,
} from './generation-audit.js'
import type { StagedGenerationAuditInput } from './artifact-store.js'
import type { PrivacyScanner } from './privacy-scanner.js'

export interface CompletePublicationAuditOptions {
  scanner: PrivacyScanner
  resolveValidationInput(
    input: StagedGenerationAuditInput,
  ): Omit<ValidateGenerationInput, 'artifactCandidates' | 'actualFiles'>
}

/**
 * 生产发布门禁：使用 Store 已打开的 no-follow session 读取 staging，统一执行
 * 27 类 Artifact、引用图、文件闭包、Authority/verdict 复算和发布前 secret 扫描。
 */
export function createCompletePublicationAuditor(
  options: CompletePublicationAuditOptions,
): (input: StagedGenerationAuditInput) => Promise<void> {
  return async (input) => {
    const validationInput = options.resolveValidationInput(input)
    if (!Object.values(validationInput.artifactPaths).includes('generation-manifest.json')) {
      throw auditError(
        'E2E_PUBLICATION_GENERATION_MANIFEST_MISSING',
        '完整发布审计必须包含正式 generation-manifest.json',
        ['generation-manifest.json'],
      )
    }
    const fileBytes = new Map<string, Uint8Array>()
    const privacyRefs: string[] = []

    for (const file of input.files) {
      const bytes = await input.readFile(file.path)
      fileBytes.set(file.path, bytes)
      if (bytes.byteLength !== file.byteLength
        || digestBytes(`generation-file:${file.path}`, bytes) !== file.digest) {
        throw auditError('E2E_PUBLICATION_FILE_CHANGED', `发布审计期间文件发生变化：${file.path}`, [file.path])
      }
      const findings = options.scanner.scan({ bytes, scope: `publication:${file.path}` })
      privacyRefs.push(...findings.map((finding) => `${file.path}:${finding.detectorId}:${finding.matchDigest}`))
    }

    const artifactCandidates: unknown[] = []
    for (const [artifactId, relativePath] of Object.entries(validationInput.artifactPaths)) {
      const bytes = fileBytes.get(relativePath)
      if (!bytes) throw auditError(
        'E2E_PUBLICATION_ARTIFACT_FILE_MISSING',
        `Artifact ${artifactId} 对应文件缺失：${relativePath}`,
        [artifactId, relativePath],
      )
      try {
        artifactCandidates.push(JSON.parse(Buffer.from(bytes).toString('utf8')))
      } catch (cause) {
        throw auditError(
          'E2E_PUBLICATION_ARTIFACT_JSON_INVALID',
          `Artifact ${artifactId} 不是合法 JSON`,
          [artifactId, relativePath],
          cause,
        )
      }
    }

    const audit = validateGeneration({
      ...validationInput,
      artifactCandidates,
      actualFiles: input.files.map((file) => ({
        relativePath: file.path,
        digest: file.digest,
        byteLength: file.byteLength,
        sanitizerOutputDigest: digestBytes('sanitizer-output/v1', fileBytes.get(file.path)!),
        bytes: fileBytes.get(file.path)!,
      })),
    })
    if (privacyRefs.length > 0 || !audit.valid) {
      throw auditError(
        'E2E_PUBLICATION_AUDIT_REJECTED',
        'Generation 未通过发布前 Schema、secret、路径、引用或 verdict 审计',
        [
          ...audit.findings.map((finding) => `${finding.code}:${finding.ref}`),
          ...privacyRefs.map((ref) => `E2E_PUBLICATION_PRIVACY_FINDING:${ref}`),
        ].sort(),
      )
    }
  }
}

function auditError(code: string, message: string, refs: string[], cause?: unknown): E2EError {
  return new E2EError({ code, category: 'artifact', message, refs, retryable: false, cause })
}
