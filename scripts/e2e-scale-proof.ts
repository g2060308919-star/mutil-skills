import { canonicalizeJson, digestText } from '@mutil-skills/e2e-contracts'
import { createPerformanceProof } from '../packages/e2e-runtime/src/performance-proof.js'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

const fixture = createScaleFixture()
const fixtureDigest = digestText('e2e-scale-fixture/v1', canonicalizeJson(fixture))
const workRoot = resolve(process.env.E2E_SCALE_PROOF_WORK_ROOT
  ?? join(homedir(), '.mutil-skills', 'e2e', 'proofs', '.scale-work'))
const outputPath = resolve(process.env.E2E_SCALE_PROOF_OUTPUT
  ?? join(homedir(), '.mutil-skills', 'e2e', 'proofs', 'scale-proof.json'))
let publicationOrdinal = 0
let sink = ''

const proof = await createPerformanceProof({
  fixtureDigest,
  fixtureCounts: { requirements: 500, rules: 2_000, obligations: 5_000, cases: 1_000 },
  samples: 10,
  phases: {
    compile: {
      budgetMs: 2_000,
      operation: () => {
        sink = digestText('e2e-scale-compile/v1', canonicalizeJson(fixture.requirements.map((requirement) => ({
          ...requirement,
          ruleIds: fixture.rules.filter((rule) => rule.requirementId === requirement.requirementId)
            .map((rule) => rule.ruleId),
        }))))
      },
    },
    'graph-audit': {
      budgetMs: 2_000,
      operation: () => {
        const requirements = new Set(fixture.requirements.map((item) => item.requirementId))
        const rules = new Set(fixture.rules.map((item) => item.ruleId))
        if (fixture.rules.some((item) => !requirements.has(item.requirementId))
          || fixture.obligations.some((item) => !requirements.has(item.requirementId)
            || !rules.has(item.ruleId))) throw new Error('scale fixture graph invalid')
      },
    },
    coverage: {
      budgetMs: 2_000,
      operation: () => {
        const covered = new Set(fixture.cases.flatMap((item) => item.obligationIds))
        if (fixture.obligations.some((item) => !covered.has(item.obligationId))) {
          throw new Error('scale fixture coverage incomplete')
        }
      },
    },
    'schedule-build': {
      budgetMs: 2_000,
      operation: () => {
        sink = fixture.cases.toSorted((left, right) => left.ordinal - right.ordinal)
          .map((item) => item.caseId).join('\0')
      },
    },
    finalization: {
      budgetMs: 5_000,
      operation: () => {
        sink = digestText('e2e-scale-finalization/v1', canonicalizeJson({
          fixtureDigest,
          requirementCount: fixture.requirements.length,
          ruleCount: fixture.rules.length,
          obligationCount: fixture.obligations.length,
          caseCount: fixture.cases.length,
        }))
      },
    },
    'report-render': {
      budgetMs: 5_000,
      operation: () => {
        const rows = fixture.cases.map((item) =>
          `<tr><td>${item.caseId}</td><td>${item.obligationIds.length}</td></tr>`).join('')
        sink = `<!doctype html><table>${rows}</table>`
      },
    },
    'workspace-publication': {
      budgetMs: 5_000,
      operation: async () => {
        publicationOrdinal += 1
        const directory = join(workRoot, `sample-${publicationOrdinal}`)
        await mkdir(directory, { recursive: true, mode: 0o700 })
        await writeFile(join(directory, 'proof-input.json'), `${canonicalizeJson({
          fixtureDigest, sinkDigest: digestText('e2e-scale-sink/v1', sink),
        })}\n`, { mode: 0o600 })
        await rm(directory, { recursive: true, force: true })
      },
    },
  },
})

await mkdir(dirname(outputPath), { recursive: true, mode: 0o700 })
await writeFile(outputPath, `${JSON.stringify(proof, null, 2)}\n`, { mode: 0o600 })
process.stdout.write(`${JSON.stringify({ ok: true, outputPath, proofDigest: proof.proofDigest })}\n`)

function createScaleFixture() {
  const requirements = Array.from({ length: 500 }, (_, index) => ({
    requirementId: `REQ-${index + 1}`,
    statement: `Requirement ${index + 1}`,
  }))
  const rules = Array.from({ length: 2_000 }, (_, index) => ({
    ruleId: `RULE-${index + 1}`,
    requirementId: `REQ-${index % requirements.length + 1}`,
  }))
  const obligations = Array.from({ length: 5_000 }, (_, index) => ({
    obligationId: `OBL-${index + 1}`,
    requirementId: `REQ-${index % requirements.length + 1}`,
    ruleId: `RULE-${index % rules.length + 1}`,
  }))
  const cases = Array.from({ length: 1_000 }, (_, index) => ({
    ordinal: index,
    caseId: `CASE-${index + 1}`,
    obligationIds: obligations.filter((_item, obligationIndex) => obligationIndex % 1_000 === index)
      .map((item) => item.obligationId),
  }))
  return { requirements, rules, obligations, cases }
}
