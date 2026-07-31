# E2E Runtime Deepening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a high-level declarative PRD compiler, durable multi-Case scheduling, standalone raw screenshot/Trace evidence bundles, scale proofs, host capability proofs, and the corresponding architecture documentation.

**Architecture:** Runtime remains the only workflow authority. A declarative compiler validates Skill-proposed Case/Action/Oracle inputs against the confirmed requirements projection, a serial scheduler owns per-Case cursors and recovery, and a standalone publisher writes evidence and reports outside Git. Performance and host proofs are separate deterministic modules.

**Tech Stack:** TypeScript 5.9, Zod 3, Vitest 3, Node.js ≥22.13, Playwright 1.61.

## Global Constraints

- Runtime must not invoke a model or infer natural-language requirements.
- Raw screenshots are published byte-for-byte without OCR, masking, or pixel redaction.
- Output defaults to `~/.mutil-skills/e2e/reports/<asset-id>/<run-id>/`.
- Git and `.biztest` publication are optional adapters.
- Case scheduling is serial and deterministic in this release.
- All target traffic remains Gateway-controlled; effect-unknown writes are never retried.
- Every production behavior follows RED → GREEN → REFACTOR.

---

### Task 1: Declarative PRD compiler contracts

**Files:**
- Create: `packages/e2e-contracts/src/declarative-prd-run.ts`
- Modify: `packages/e2e-contracts/src/index.ts`
- Test: `packages/e2e-contracts/test/declarative-prd-run.test.ts`

**Interfaces:**
- Produces: `DeclarativePrdRunDesignSchema`, `CompiledPrdRunPlanSchema`, `digestCompiledPrdRunPlan()`.

- [ ] **Step 1: Write a failing contract test**

```ts
test('accepts contract-bound cases and rejects caller-owned artifact facts', () => {
  const design = designFixture()
  expect(DeclarativePrdRunDesignSchema.parse(design).cases).toHaveLength(3)
  expect(() => DeclarativePrdRunDesignSchema.parse({
    ...design, cases: [{ ...design.cases[0], contentDigest: d('forged') }],
  })).toThrow()
})
```

- [ ] **Step 2: Run RED**

Run: `npx vitest run packages/e2e-contracts/test/declarative-prd-run.test.ts`
Expected: FAIL because the new module/export does not exist.

- [ ] **Step 3: Implement strict schemas**

```ts
export const DeclarativePrdRunDesignSchema = z.object({
  schemaVersion: z.literal('1.0.0'),
  cases: z.array(z.object({
    caseKey: SafeIdSchema,
    title: TextSchema,
    actor: SafeIdSchema,
    contractNodeIds: z.array(SafeIdSchema).min(1),
    actions: z.array(DeclarativeActionSchema).min(1),
    oracles: z.array(DeclarativeOracleSchema).min(1),
    failurePolicy: z.enum(['stop-required', 'continue']),
  }).strict()).min(1).max(1_000),
}).strict()
```

- [ ] **Step 4: Run GREEN and contract package tests**

Run: `npx vitest run packages/e2e-contracts/test/declarative-prd-run.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/e2e-contracts
git commit -m "feat(e2e): define declarative PRD run contracts"
```

### Task 2: PRDRunCompiler deep module

**Files:**
- Create: `packages/e2e-runtime/src/prd-run-compiler.ts`
- Modify: `packages/e2e-runtime/src/index.ts`
- Test: `packages/e2e-runtime/test/prd-run-compiler.test.ts`

**Interfaces:**
- Consumes: `PrdUnderstandingProjection`, `DeclarativePrdRunDesign`.
- Produces: `compilePrdRun(input): CompiledPrdRunPlan`.

- [ ] **Step 1: Write failing deterministic and completeness tests**

```ts
test('compiles three cases and binds every oracle to one acceptance criterion', () => {
  const first = compilePrdRun(inputFixture())
  const second = compilePrdRun(inputFixture())
  expect(first).toEqual(second)
  expect(first.cases.map((item) => item.caseId)).toEqual(['CASE-0001', 'CASE-0002', 'CASE-0003'])
  expect(first.compilerDigest).toMatch(/^sha256:/)
})

test('blocks a design that omits a confirmed acceptance criterion', () => {
  const input = inputFixture()
  input.design.cases[0]!.oracles = []
  expect(() => compilePrdRun(input)).toThrow(/E2E_RUNTIME_PRD_RUN_ACCEPTANCE_UNMAPPED/)
})
```

- [ ] **Step 2: Run RED**

Run: `npx vitest run packages/e2e-runtime/test/prd-run-compiler.test.ts`
Expected: FAIL because `compilePrdRun` is missing.

- [ ] **Step 3: Implement deterministic compilation**

```ts
export function compilePrdRun(input: CompilePrdRunInput): CompiledPrdRunPlan {
  const projection = PrdUnderstandingProjectionSchema.parse(input.understanding)
  const design = DeclarativePrdRunDesignSchema.parse(input.design)
  assertAllAuthorizedNodesMapped(projection, design)
  const content = normalizeCases(projection, design)
  return CompiledPrdRunPlanSchema.parse({
    schemaVersion: '1.0.0',
    contractProjectionDigest: projection.projectionDigest,
    cases: content,
    compilerDigest: digestText('compiled-prd-run/v1', canonicalizeJson(content)),
  })
}
```

- [ ] **Step 4: Run GREEN, package test, and typecheck**

Run: `npx vitest run packages/e2e-runtime/test/prd-run-compiler.test.ts && npx tsc -b packages/e2e-runtime`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/e2e-runtime
git commit -m "feat(e2e): compile declarative PRD runs"
```

### Task 3: Durable serial MultiCaseScheduler

**Files:**
- Create: `packages/e2e-runtime/src/multi-case-scheduler.ts`
- Modify: `packages/e2e-runtime/src/index.ts`
- Test: `packages/e2e-runtime/test/multi-case-scheduler.test.ts`

**Interfaces:**
- Produces: `createCaseSchedule()`, `startNextCase()`, `completeCase()`, `recoverCaseSchedule()`.

- [ ] **Step 1: Write failing scheduler tests**

```ts
test('executes three cases in frozen order with independent terminals', () => {
  let state = createCaseSchedule(planFixture())
  state = startNextCase(state, 'ATTEMPT-1')
  state = completeCase(state, passed('CASE-0001'))
  state = startNextCase(state, 'ATTEMPT-2')
  expect(state.cases.map((item) => item.state)).toEqual(['passed', 'running', 'pending'])
})

test('effect-unknown blocks retry and recovery selects cleanup first', () => {
  const recovered = recoverCaseSchedule(effectUnknownFixture())
  expect(recovered.next).toEqual({ kind: 'cleanup', caseId: 'CASE-0002' })
  expect(() => startNextCase(recovered.state, 'ATTEMPT-RETRY'))
    .toThrow(/E2E_RUNTIME_EFFECT_UNKNOWN_RETRY_DENIED/)
})
```

- [ ] **Step 2: Run RED**

Run: `npx vitest run packages/e2e-runtime/test/multi-case-scheduler.test.ts`
Expected: FAIL because scheduler functions are missing.

- [ ] **Step 3: Implement immutable transition functions**

```ts
export type CaseExecutionState =
  | 'pending' | 'preflight' | 'ready' | 'running' | 'cleanup'
  | 'passed' | 'failed' | 'unable' | 'safety-blocked'

export function startNextCase(
  schedule: RuntimeCaseSchedule,
  attemptId: string,
): RuntimeCaseSchedule
```

Every transition validates the current state, increments `revision`, preserves terminal records, and derives `scheduleDigest`.

- [ ] **Step 4: Run GREEN**

Run: `npx vitest run packages/e2e-runtime/test/multi-case-scheduler.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/e2e-runtime
git commit -m "feat(e2e): add durable multi-case scheduler"
```

### Task 4: Project multiple full-playwright Cases

**Files:**
- Modify: `packages/e2e-runtime/src/runtime-full-playwright-projector.ts`
- Modify: `packages/e2e-runtime/src/trusted-action-runner.ts`
- Test: `packages/e2e-runtime/test/runtime-full-playwright-projector.test.ts`

**Interfaces:**
- Produces: `projectRuntimeFullPlaywrightCases(snapshot): RuntimeFullPlaywrightProjection[]`.
- Keeps: `projectRuntimeFullPlaywrightSnapshot()` as a one-Case compatibility wrapper.

- [ ] **Step 1: Add a failing three-Case projection test**

```ts
test('projects every scheduled full-playwright case without merging identities', () => {
  const snapshot = runtimeFullPlaywrightProjectionFixture({ cases: 3 })
  const projections = projectRuntimeFullPlaywrightCases(snapshot)
  expect(projections.map((item) => item.caseId)).toEqual(['CASE-1', 'CASE-2', 'CASE-3'])
  expect(new Set(projections.map((item) => item.sourceSetDigest)).size).toBe(3)
})
```

- [ ] **Step 2: Run RED**

Run: `npx vitest run packages/e2e-runtime/test/runtime-full-playwright-projector.test.ts`
Expected: FAIL because the array projector is missing and the current projector rejects multiple entries.

- [ ] **Step 3: Extract a per-schedule projection**

```ts
export function projectRuntimeFullPlaywrightCases(
  snapshot: RuntimeRunSnapshot,
): RuntimeFullPlaywrightProjection[] {
  return parseSchedule(snapshot).map((entry) => projectScheduledCase(snapshot, entry))
}
```

Each projection must match exactly one program, action, cleanup plan, grant capability, data need, schedule record, test Case and actor.

- [ ] **Step 4: Run GREEN and regression tests**

Run: `npx vitest run packages/e2e-runtime/test/runtime-full-playwright-projector.test.ts packages/e2e-runtime/test/trusted-action-runner.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/e2e-runtime
git commit -m "feat(e2e): project multiple full-playwright cases"
```

### Task 5: Standalone raw Evidence Bundle

**Files:**
- Create: `packages/e2e-runtime/src/standalone-evidence-publisher.ts`
- Modify: `packages/e2e-runtime/src/index.ts`
- Modify: `packages/e2e-report/src/complete-report.ts`
- Test: `packages/e2e-runtime/test/standalone-evidence-publisher.test.ts`
- Test: `packages/e2e-report/test/complete-report.test.ts`

**Interfaces:**
- Produces: `StandaloneEvidencePublisher.publish(input): Promise<string>`.

- [ ] **Step 1: Write failing byte-preservation and path-safety tests**

```ts
test('publishes raw screenshot bytes unchanged outside a Git repository', async () => {
  const root = await publisher.publish(bundleFixture())
  expect(await readFile(join(root, 'evidence/CASE-1/CHECKPOINT-1.png')))
    .toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47]))
  expect(JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8')).files)
    .toHaveProperty('evidence/CASE-1/CHECKPOINT-1.png')
})

test('rejects symlinked output roots and evidence path traversal', async () => {
  await expect(publisher.publish(bundleFixture({ path: '../secret.png' })))
    .rejects.toThrow(/E2E_EVIDENCE_OUTPUT_PATH_INVALID/)
})
```

- [ ] **Step 2: Run RED**

Run: `npx vitest run packages/e2e-runtime/test/standalone-evidence-publisher.test.ts`
Expected: FAIL because publisher is missing.

- [ ] **Step 3: Implement atomic standalone publication**

```ts
export interface StandaloneEvidenceFile {
  caseId: string
  checkpointId: string
  kind: 'screenshot' | 'trace' | 'dom'
  relativePath: string
  bytes: Uint8Array
}
```

Create a `0700` temporary directory, write `0600` files with `wx`, create a digest manifest, then atomically rename. Never alter screenshot bytes.

- [ ] **Step 4: Render screenshot and Trace links**

The HTML renderer uses validated relative paths and emits `<img>` for screenshots plus a download link for Trace. CSP remains offline-only.

- [ ] **Step 5: Run GREEN**

Run: `npx vitest run packages/e2e-runtime/test/standalone-evidence-publisher.test.ts packages/e2e-report/test/complete-report.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/e2e-runtime packages/e2e-report
git commit -m "feat(e2e): publish standalone screenshot and trace evidence"
```

### Task 6: Performance proof

**Files:**
- Create: `packages/e2e-runtime/src/performance-proof.ts`
- Create: `scripts/e2e-scale-proof.ts`
- Modify: `package.json`
- Test: `packages/e2e-runtime/test/performance-proof.test.ts`

**Interfaces:**
- Produces: `nearestRankPercentile()`, `createPerformanceProof()`, `verify:e2e-scale`.

- [ ] **Step 1: Write failing percentile and proof tests**

```ts
test('uses deterministic nearest-rank p95', () => {
  expect(nearestRankPercentile([1, 2, 3, 4, 100], 95)).toBe(100)
})

test('binds 500/2000/5000/1000 fixture counts into the proof', async () => {
  const proof = await createPerformanceProof(scaleFixture(), { samples: 10 })
  expect(proof.fixtureCounts).toEqual({
    requirements: 500, rules: 2000, obligations: 5000, cases: 1000,
  })
  expect(proof.proofDigest).toMatch(/^sha256:/)
})
```

- [ ] **Step 2: Run RED**

Run: `npx vitest run packages/e2e-runtime/test/performance-proof.test.ts`
Expected: FAIL because the proof module is missing.

- [ ] **Step 3: Implement measurement and proof serialization**

Use injected `measure(phase)` operations in tests and real `performance.now()` plus `process.memoryUsage().rss` in the script. Reject fewer than 10 samples and non-finite durations.

- [ ] **Step 4: Add command**

```json
"verify:e2e-scale": "tsx scripts/e2e-scale-proof.ts"
```

- [ ] **Step 5: Run GREEN and real proof**

Run: `npx vitest run packages/e2e-runtime/test/performance-proof.test.ts && npm run verify:e2e-scale`
Expected: PASS and a JSON proof path.

- [ ] **Step 6: Commit**

```bash
git add package.json scripts/e2e-scale-proof.ts packages/e2e-runtime
git commit -m "test(e2e): add large-scale p95 proof"
```

### Task 7: Host capability proof and required matrix

**Files:**
- Create: `packages/e2e-runtime/src/host-capability-proof.ts`
- Create: `scripts/e2e-host-proof.ts`
- Modify: `package.json`
- Test: `packages/e2e-runtime/test/host-capability-proof.test.ts`

**Interfaces:**
- Produces: `probeHostCapabilities()`, `assertRequiredHostCapabilities()`, `verify:e2e-host`.

- [ ] **Step 1: Write failing probe classification tests**

```ts
test('fails when a required supported capability was not executed', async () => {
  const proof = proofFixture({ loopback: { status: 'supported-not-executed' } })
  expect(() => assertRequiredHostCapabilities(proof, ['loopback']))
    .toThrow(/E2E_HOST_CAPABILITY_NOT_EXECUTED/)
})

test('distinguishes unsupported host from business failure', async () => {
  const proof = await probeHostCapabilities(blockedOperations())
  expect(proof.capabilities.loopback).toMatchObject({
    status: 'unsupported', reasonCode: 'E2E_HOST_LOOPBACK_UNAVAILABLE',
  })
})
```

- [ ] **Step 2: Run RED**

Run: `npx vitest run packages/e2e-runtime/test/host-capability-proof.test.ts`
Expected: FAIL because the proof module is missing.

- [ ] **Step 3: Implement injected probes and real Node adapter**

Probe loopback, process, POSIX filesystem, atomic rename/fsync, browser selection, disposable Profile and Gateway canary. Each result carries status, reasonCode and proof digest.

- [ ] **Step 4: Add CLI command**

```json
"verify:e2e-host": "tsx scripts/e2e-host-proof.ts"
```

`--require=loopback,process,filesystem` must fail if any required capability is unsupported or unexecuted.

- [ ] **Step 5: Replace broad conditional skip entry points**

Host adapter suites read one shared proof. In normal unrestricted host verification, loopback/process/filesystem are required and skipped tests are a failure; restricted sandbox runs verify stable unsupported reason codes.

- [ ] **Step 6: Run GREEN**

Run: `npx vitest run packages/e2e-runtime/test/host-capability-proof.test.ts && npm run verify:e2e-host -- --require=process,filesystem`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add package.json scripts/e2e-host-proof.ts packages/e2e-runtime
git commit -m "test(e2e): prove host integration capabilities"
```

### Task 8: E2E domain context and ADRs

**Files:**
- Modify: `CONTEXT.md`
- Create: `docs/adr/0005-e2e-runtime-workflow-authority.md`
- Create: `docs/adr/0006-deterministic-prd-run-compilation.md`
- Create: `docs/adr/0007-multi-case-attempt-and-recovery.md`
- Create: `docs/adr/0008-standalone-raw-evidence-workspace.md`
- Create: `docs/adr/0009-host-capability-proofs.md`

**Interfaces:**
- Documents current ownership and accepted decisions; no runtime API.

- [ ] **Step 1: Update current domain truth**

Document the chain:

```text
Requirements Contract → PRDRunCompiler → Artifact Graph
→ MultiCaseScheduler → Browser/Gateway/Authority
→ Evidence Bundle → Engine Verdict → Report
```

- [ ] **Step 2: Record decisions and rejected alternatives**

Each ADR includes Status, Date, Context, Decision, Alternatives and Consequences. Explicitly reject Skill-owned workflow state, external Controller authority, merged mega-Case results, mandatory Git publication and capability tests that silently skip everywhere.

- [ ] **Step 3: Self-review documentation**

Run: `rg -n "TBD|TODO|待定" CONTEXT.md docs/adr/000{5,6,7,8,9}-*.md`
Expected: no output.

- [ ] **Step 4: Commit**

```bash
git add CONTEXT.md docs/adr
git commit -m "docs(e2e): record runtime domain decisions"
```

### Task 9: Integration, migration, and Golden

**Files:**
- Modify: `packages/e2e-runtime/src/run-store.ts`
- Modify: `packages/e2e-runtime/src/runtime-state-migration.ts`
- Modify: `packages/e2e-runtime/src/runtime-host.ts`
- Modify: `packages/e2e-contracts/src/runtime-host.ts`
- Modify: `packages/skills/skills/testing/e2e/SKILL.md`
- Test: `packages/e2e-runtime/test/runtime-state-migration.test.ts`
- Test: `packages/e2e-runtime/test/runtime-host.test.ts`
- Test: `scripts/e2e-runtime-cross-repo.golden.test.ts`

**Interfaces:**
- Adds high-level `compile-prd-run` RPC and persisted scheduler state.
- Maps legacy single-Case snapshots to one-element schedules.

- [ ] **Step 1: Write failing RPC and migration tests**

```ts
test('compile-prd-run persists compiler plan and scheduler atomically', async () => {
  const response = await host.handle(compileRequestFixture())
  expect(response).toMatchObject({ ok: true, result: {
    caseCount: 3, nextRequiredDecision: 'scope',
  } })
  expect((await store.getRun(projectDigest, 'RUN-1'))?.caseSchedule?.cases).toHaveLength(3)
})

test('migrates a 1.6 single-case snapshot to a one-item durable schedule', () => {
  expect(migrateRuntimeRunSnapshot(legacyFixture()).caseSchedule?.cases).toHaveLength(1)
})
```

- [ ] **Step 2: Run RED**

Run: `npx vitest run packages/e2e-runtime/test/runtime-host.test.ts packages/e2e-runtime/test/runtime-state-migration.test.ts`
Expected: FAIL because RPC and snapshot fields do not exist.

- [ ] **Step 3: Add protocol, Host handler, and schema 1.7 migration**

Persist `compiledPrdRun` and `caseSchedule` in one Run Store mutation. The RPC response exposes only compiler digest, review, unresolved items and next decision.

- [ ] **Step 4: Update Skill high-level flow**

The Skill sends one declarative design to `compile-prd-run`; it no longer instructs the model to submit low-level requirement/coverage/test/execution candidates individually.

- [ ] **Step 5: Expand Golden**

The controlled target executes at least three independent Cases and publishes raw screenshots plus Trace to an explicit standalone outputRoot.

- [ ] **Step 6: Run focused GREEN**

Run: `npx vitest run packages/e2e-runtime/test/runtime-host.test.ts packages/e2e-runtime/test/runtime-state-migration.test.ts scripts/e2e-runtime-cross-repo.golden.test.ts --config vitest.e2e.config.ts`
Expected: PASS with no pending tests in the selected Golden.

- [ ] **Step 7: Commit**

```bash
git add packages/e2e-contracts packages/e2e-runtime packages/skills scripts
git commit -m "feat(e2e): integrate compiler scheduler and evidence golden"
```

### Task 10: Final verification and review

**Files:**
- Modify only files required by review findings.

- [ ] **Step 1: Run all static gates**

Run: `npm run typecheck && npm run lint:architecture && npm run build`
Expected: PASS.

- [ ] **Step 2: Run the full suite**

Run: `npm test`
Expected: PASS; environment-limited suites must be classified by HostCapabilityProof.

- [ ] **Step 3: Run capability proofs**

Run: `npm run verify:e2e-scale && npm run verify:e2e-host -- --require=process,filesystem`
Expected: PASS and machine-readable proof files.

- [ ] **Step 4: Run Workspace Golden**

Run: `npm run verify:e2e-pack`
Expected: `{"ok":true,"mode":"pack","skippedTests":0,...}`.

- [ ] **Step 5: Review all changes**

Use `/code-review`; fix P0/P1 findings with a failing regression test before production changes.

- [ ] **Step 6: Commit final fixes**

```bash
git add -A
git commit -m "fix(e2e): close runtime deepening review findings"
```

- [ ] **Step 7: Push**

```bash
git push origin feat-initial
```
