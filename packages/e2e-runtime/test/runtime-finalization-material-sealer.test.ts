import {
  ArtifactSchemaRegistry,
  digestArtifactContent,
  digestBytes,
  digestText,
  type ArtifactDocument,
} from '@mutil-skills/e2e-contracts'
import { buildCompleteGeneration } from '@mutil-skills/e2e-engine'
import { describe, expect, test, vi } from 'vitest'
import { completeGenerationFixture } from '../../e2e-engine/test/complete-generation.fixture.js'
import { projectionFixture } from './trusted-action-runner.test.js'
import {
  RuntimeFinalizationMaterialSealer,
  runtimeProductionSanitizerPolicyDigest,
} from '../src/runtime-finalization-material-sealer.js'
import type { RuntimeRunSnapshot } from '../src/run-store.js'

describe('RuntimeFinalizationMaterialSealer', () => {
  test('只从冻结资产、可信执行事实和 Quarantine 生成 25 类可追踪事实', async () => {
    const fixture = completeGenerationFixture()
    const built = buildCompleteGeneration(fixture)
    const facts = built.artifacts.filter((artifact) =>
      !['final-report', 'generation-manifest'].includes(artifact.artifactType))
    const frozenArtifacts = Object.fromEntries(facts.filter((artifact) => ![
      'approval-grants', 'manual-results', 'data-leases', 'browser-preflight', 'run-bundle',
      'workflow-events', 'browser-results', 'gateway-audit', 'browser-evidence', 'diagnosis',
      'cleanup-results',
    ].includes(artifact.artifactType)).map((artifact) => [artifact.artifactType,
      artifact.artifactType === 'project-policy' ? withEvidencePolicy(artifact) : artifact]))
    const projection = projectionFixture()
    const dom = Buffer.from(JSON.stringify({
      format: 'dom-tree/1', roots: [{ tag: 'main', text: 'Home', assertionRelevant: true }],
    }))
    const stored = new Map<string, Buffer>([['raw/ATTEMPT-1/dom.bin', dom]])
    const workflow = (fixture.drafts['workflow-events'].content as any).attemptCases[0]
    const grants = (fixture.drafts['approval-grants'].content as any).grants
    const authority = {
      ...fixture.authority,
      stateProtectionLevel: 'local-crash-integrity' as const,
      artifactVerifierMaterial: { publicKeyDigest: digestText('test/v1', 'artifact') },
      approvalFreshnessVerifierMaterial: { kind: 'test' }, decisionVerifierMaterial: { kind: 'test' },
      privacyReviewVerifierMaterial: { kind: 'test' }, attemptEventVerifierMaterial: { kind: 'test' },
      signDigest: fixture.authority.signArtifactDigest,
      verifySignature: (signature: any) => fixture.authority.verifyArtifactSignature(signature, signature.signedDigest),
      issueApprovalFreshnessReceipt: vi.fn(async () => grants[0]),
      appendAttemptEvent: vi.fn(({ event }: any) => event.sequence === 1
        ? { event: workflow.events[0], eventChainDigest: workflow.events[1].previousChainDigest }
        : { event: workflow.events[1], eventChainDigest: workflow.selection.eventChainDigest }),
      close: vi.fn(), credentialCount: 1,
    }
    const material = await new RuntimeFinalizationMaterialSealer({
      quarantine: {
        readEvidence: async ({ relativePath }: any) => Buffer.from(stored.get(relativePath)!),
        writeEvidence: async ({ relativePath, plaintext }: any) => {
          if (stored.has(relativePath)) throw new Error('duplicate')
          stored.set(relativePath, Buffer.from(plaintext))
          return {} as never
        },
      },
      authority: authority as never,
      runtimeVersion: '0.1.0', contractsVersion: '0.1.0', engineVersion: '0.1.0',
      playwrightVersion: '1.61.1',
    }).seal(snapshot({ frozenArtifacts, projection, fixture, dom }))

    expect(material.artifacts).toHaveLength(25)
    expect(new Set(material.artifacts.map(({ artifact }) => artifact.artifactType)).size).toBe(25)
    expect(material.evidence).toEqual([expect.objectContaining({
      evidenceId: 'EVIDENCE-ACTION-1', quarantinePath: 'sanitized/EVIDENCE-ACTION-1.json',
    })])
    expect(stored.get('sanitized/EVIDENCE-ACTION-1.json')?.toString()).not.toContain('Bearer ')
    expect(authority.issueApprovalFreshnessReceipt).toHaveBeenCalledOnce()
    expect(authority.appendAttemptEvent).toHaveBeenCalledTimes(2)
  })

  test('缺少任何外部语义资产时阻止最终化，不补空资产', async () => {
    const fixture = completeGenerationFixture()
    const projection = projectionFixture()
    const sealer = new RuntimeFinalizationMaterialSealer({
      quarantine: {} as never, authority: fixture.authority as never,
      runtimeVersion: '0.1.0', contractsVersion: '0.1.0', engineVersion: '0.1.0',
      playwrightVersion: '1.61.1',
    })
    await expect(sealer.seal(snapshot({ frozenArtifacts: {}, projection, fixture, dom: Buffer.alloc(0) })))
      .rejects.toMatchObject({ code: expect.stringContaining('EXTERNAL_ARTIFACT_MISSING') })
  })
})

function withEvidencePolicy(artifact: ArtifactDocument): ArtifactDocument {
  const candidate = structuredClone(artifact) as any
  candidate.content.evidencePolicy.digest = runtimeProductionSanitizerPolicyDigest()
  candidate.signatures = []
  candidate.contentDigest = digestArtifactContent(
    `artifact-content/${candidate.schemaVersion}/${candidate.artifactType}`, candidate,
  )
  return ArtifactSchemaRegistry['project-policy'].parse(candidate)
}

function snapshot(input: {
  frozenArtifacts: Record<string, ArtifactDocument>
  projection: ReturnType<typeof projectionFixture>
  fixture: ReturnType<typeof completeGenerationFixture>
  dom: Buffer
}): RuntimeRunSnapshot {
  const gatewayAudit = input.fixture.drafts['gateway-audit'].content
  return {
    schemaVersion: '1.4.0', runId: 'GEN-1', assetId: 'ASSET-1',
    projectIdentityDigest: digestText('test/v1', 'project'),
    runtimeInstallationDigest: digestText('test/v1', 'runtime'), runRevision: 1,
    workflow: { current: 'diagnosing', sequence: 10, eventChainDigest: digestText('test/v1', 'workflow') },
    artifactDigests: { 'prd-source': input.fixture.context.prdRevision },
    frozenArtifacts: input.frozenArtifacts,
    trustedExecutionFacts: {
      'signed-discovery-grant': input.projection.trustedExecutionFacts['signed-discovery-grant'],
      'signed-execution-grant': input.projection.grant,
      'browser-preflight': {
        runId: 'GEN-1', discoveryGrantId: (input.projection.trustedExecutionFacts['signed-discovery-grant'] as any).grantId,
        reservationId: 'RES-PREFLIGHT', preflightDigest: digestText('test/v1', 'preflight'), status: 'ready',
        observedIdentityDigest: digestText('test/v1', 'identity'),
        browserMeasurementDigest: digestText('test/v1', 'browser'),
        browserClosureDigest: digestText('test/v1', 'closure'),
        browserExecutableDigest: digestText('test/v1', 'executable'),
        gatewaySessionMeasurementDigest: digestText('test/v1', 'gateway-session'),
        gatewayPolicyDigest: (gatewayAudit as any).policyDigest,
        gatewayAuditDigest: digestText('test/v1', 'preflight-audit'),
        canaryProofDigest: digestText('test/v1', 'canary'),
        authorityOutcomeDigest: digestText('test/v1', 'authority-outcome'),
        authorityReceiptDigest: digestText('test/v1', 'authority-receipt'),
      },
      'finalization-execution-facts': {
        gatewayAudit,
        gatewayAuditVerifierMaterial: { issuer: 'test' },
        browserMeasurements: {}, isolationMeasurements: {},
      },
      'quarantined-evidence': {
        schemaVersion: '1.0.0', runId: 'GEN-1', attemptId: 'ATTEMPT-1', records: [
          { evidenceType: 'screenshot', quarantinePath: 'raw/ATTEMPT-1/screenshot.bin',
            plaintextDigest: digestBytes('quarantine-plaintext/v1', Buffer.alloc(0)), byteLength: 0 },
          { evidenceType: 'dom', quarantinePath: 'raw/ATTEMPT-1/dom.bin',
            plaintextDigest: digestBytes('quarantine-plaintext/v1', input.dom), byteLength: input.dom.byteLength },
        ],
      },
    },
    writeAttempts: {},
    executionResults: { readEnvironment: { 'ACTION-1': {
      attemptId: 'ATTEMPT-1', caseId: 'CASE-1', actionId: 'ACTION-1', status: 'passed',
      result: { caseId: 'CASE-1', actionId: 'ACTION-1', status: 'passed', expected: ['Home'],
        actual: ['Home'], evidence: [], reservationIds: ['RESERVATION-1'],
        outcomeDigest: digestText('test/v1', 'outcome') },
      gatewayAudit: { received: 1, forwarded: 1, blocked: 0, byIntent: {} },
      gatewayAuditDigest: digestText('test/v1', 'audit'),
    } }, realEnvironment: {}, gatewayInjection: {} },
    requestResponses: {}, createdAt: '2026-07-18T00:00:00.000Z', updatedAt: '2026-07-18T00:00:00.000Z',
  }
}
