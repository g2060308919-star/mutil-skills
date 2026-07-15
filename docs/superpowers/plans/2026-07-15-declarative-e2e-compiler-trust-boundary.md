# Declarative E2E Compiler Trust Boundary Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将现有 PRD E2E 回归链收紧为“声明式 Artifact 投影 → 可信 Compiler → Source Set 证明 → 执行前复验”，并隔离人工 Playwright 与可信报告。

**Architecture:** 保留现有 Playwright Compiler、Discovery Authority、Controlled Write Bridge 和 Engine 审计，在 Contracts 中增加规范化 Compiler Input 与回归证明 V2，在 Runtime 中增加 Artifact Projector 和不可伪造的执行前复验会话。可信可逆写不再强制依赖任意代码隔离证明，但生产隔离入口继续保留为更高能力 Profile。

**Tech Stack:** TypeScript 5.8、Zod 3.25、Vitest 3.2、Playwright 1.61、Node.js Ed25519/文件系统 API。

## Global Constraints

- AI/调用方不得向可信链提供源码 bytes、Playwright config、hook、fixture、reporter、依赖或 discovered Case IDs。
- Compiler Input 只能由同代、同 Asset、同 PRD revision 的 Artifact 投影产生。
- blocked Case 不生成 spec、skip、fixme、todo 或空断言。
- 人工 Playwright 保持可运行，但 `testDomain=ordinary` 永远不能贡献 PRD E2E verdict。
- `trusted-reversible-write` 不等于 `production-isolated`；生产隔离 API 和证明继续保留。
- Discovery 和每次执行前都必须从实际磁盘 bytes 枚举并重算完整 Source Set。
- 所有行为变化执行严格 RED → GREEN；不得先写实现再补测试。
- 当前工作树存在大量用户改动；只修改本计划列出的文件，不自动 stage、commit 或合并。

---

## 文件结构映射

- `packages/e2e-contracts/src/compiler-input.ts`：声明式 Compiler Input V1、canonical digest 和封闭 Action Schema。
- `packages/e2e-contracts/src/regression-discovery.ts`：Discovery Attestation V2、测试域、执行 Profile 和 Source Set 契约。
- `packages/e2e-contracts/src/artifacts.ts`：regression manifest 登记测试域和执行 Profile。
- `packages/e2e-playwright-runtime/src/compiler-input-projector.ts`：从已验证 Artifact 集投影唯一 Compiler Input。
- `packages/e2e-playwright-runtime/src/compiler.ts`：内部确定性 Compiler；fresh root、排他写和固定输出。
- `packages/e2e-playwright-runtime/src/regression-source-set.ts`：统一安全枚举、拒绝链接和磁盘摘要计算。
- `packages/e2e-playwright-runtime/src/regression-discovery.ts`：只接受投影后的 opaque 输入，生成 V2 专用证明。
- `packages/e2e-playwright-runtime/src/trusted-compiler-execution.ts`：执行前 TOCTOU 复验与不可伪造会话。
- `packages/e2e-playwright-runtime/src/controlled-write-bridge.ts`：新增可信编译 Profile launcher，保留生产隔离 launcher。
- `packages/e2e-engine/src/generation-audit.ts`：按执行 Profile 审计 runtime isolation 和报告来源资格。
- `packages/e2e-engine/test/complete-generation.fixture.ts`：V2 regression fixture 和可信测试域事实。
- `scripts/e2e-read-only.golden.test.ts`、`scripts/e2e-write.golden.test.ts`：真实 Chromium 主链改走 Projector/Compiler V2。
- `packages/skills/skills/testing/e2e/regression-publication.md`、`safety-gateway.md`、`SKILL.md`：中文说明新的唯一可信入口和 Profile 语义。

---

### Task 1: Compiler Input 与 Discovery V2 Contracts

**Files:**
- Create: `packages/e2e-contracts/src/compiler-input.ts`
- Modify: `packages/e2e-contracts/src/index.ts`
- Modify: `packages/e2e-contracts/src/regression-discovery.ts`
- Modify: `packages/e2e-contracts/src/artifacts.ts`
- Create: `packages/e2e-contracts/test/compiler-input.test.ts`
- Modify: `packages/e2e-contracts/test/regression-discovery-attestation.test.ts`

**Interfaces:**
- Produces: `CompilerInputV1Schema`、`computeCompilerInputDigest(input)`、`CompilerInputV1`。
- Produces: `RegressionDiscoverySubjectV2`，固定 `testDomain='prd-e2e-trusted-compiler'` 和三种 `executionProfile`。
- Consumes: 现有 `RegressionSourceFileSchema`、`RegressionBlockedCasesSchema`、canonical JSON/digest helpers。

- [x] **Step 1: 写 Compiler Input 严格 Schema 的失败测试**

```ts
const input = compilerInputFixture()
expect(CompilerInputV1Schema.parse(input)).toEqual(input)
expect(CompilerInputV1Schema.safeParse({ ...input, sourceFiles: [{ bytes: 'evil' }] }).success).toBe(false)
expect(CompilerInputV1Schema.safeParse({ ...input, cases: [{
  ...input.cases[0], actions: [{ kind: 'customCode', source: 'process.env' }],
}] }).success).toBe(false)
expect(computeCompilerInputDigest(input)).toBe(computeCompilerInputDigest(structuredClone(input)))
```

- [x] **Step 2: 运行 Contracts 定向测试并确认 RED**

Run: `npx vitest run packages/e2e-contracts/test/compiler-input.test.ts packages/e2e-contracts/test/regression-discovery-attestation.test.ts`

Expected: FAIL，提示 `compiler-input.js` 或 V2 字段不存在。

- [x] **Step 3: 实现 Compiler Input V1**

```ts
export const CompilerInputV1Schema = z.object({
  schemaVersion: z.literal('compiler-input/v1'),
  assetId: AssetIdSchema,
  generationId: SafeIdSchema,
  prdRevision: DigestSchema,
  contractsVersion: SemverSchema,
  environmentId: SafeIdSchema,
  approvalDigest: DigestSchema,
  policyDigest: DigestSchema,
  playwrightVersion: SemverSchema,
  cases: z.array(DeclarativeExecutableCaseSchema).min(1),
  blockedCases: RegressionBlockedCasesSchema,
}).strict().superRefine(refineCaseClosure)

export function computeCompilerInputDigest(input: CompilerInputV1): string {
  return digestText('regression-compiler-input/v2', canonicalizeJson(CompilerInputV1Schema.parse(input)))
}
```

Action 只允许 `assertText` 与 `reversibleWrite`；所有对象 `.strict()`；Case、Action、reqIds 排序和唯一性在 refinement 中强制。

- [x] **Step 4: 将 Discovery 证明升级为 V2**

```ts
const RegressionDiscoverySubjectObjectSchema = z.object({
  schemaVersion: z.literal('2.0.0'),
  testDomain: z.literal('prd-e2e-trusted-compiler'),
  executionProfile: z.enum(['trusted-read-only', 'trusted-reversible-write', 'production-isolated']),
  compilerVersion: SemverSchema,
  templateVersion: SemverSchema,
  contractsVersion: SemverSchema,
  environmentId: SafeIdSchema,
  approvalDigest: DigestSchema,
  policyDigest: DigestSchema,
  templateDigest: DigestSchema,
  compilerInputDigest: DigestSchema,
  sourceFiles: z.array(RegressionSourceFileSchema).min(1).max(100_000),
  caseMappings: z.array(RegressionCaseMappingSchema).min(1).max(100_000),
  toolchain: RegressionToolchainSchema,
  isolation: RegressionListIsolationSchema,
  discoveredCaseIds: UniqueCaseIdsSchema,
  blockedCases: RegressionBlockedCasesSchema,
  sourceSetDigest: DigestSchema,
}).strict()
```

证明 purpose 改为 `regression-discovery-attestation/v2`；V1 candidate 必须返回 migration-required/Schema 失败，不允许静默补值。`regression-manifest` 顶层增加相同 `testDomain` 与 `executionProfile`，并与 attestation 精确相等。

- [x] **Step 5: 运行 Contracts 测试并确认 GREEN**

Run: `npx vitest run packages/e2e-contracts/test/compiler-input.test.ts packages/e2e-contracts/test/regression-discovery-attestation.test.ts packages/e2e-contracts/test/artifact-registry.test.ts`

Expected: PASS。

- [x] **Step 6: 记录提交检查点（不执行 Git 写操作）**

Checkpoint message: `feat(e2e): add declarative compiler input and discovery v2 contracts`

---

### Task 2: Artifact Projector 成为唯一公共 Compiler 输入入口

**Files:**
- Create: `packages/e2e-playwright-runtime/src/compiler-input-projector.ts`
- Create: `packages/e2e-playwright-runtime/test/compiler-input-projector.test.ts`
- Modify: `packages/e2e-playwright-runtime/src/index.ts`
- Modify: `packages/e2e-playwright-runtime/src/compiler.ts`
- Modify: `packages/e2e-playwright-runtime/test/compiler.test.ts`

**Interfaces:**
- Consumes: `ArtifactDocument[]` 中 `project-policy`、`requirement-model`、`coverage-universe`、`test-cases`、`browser-action-map`、`execution-contract`、`approval-grants`。
- Produces: `projectCompilerInputFromArtifacts(input): TrustedCompilerInput`；opaque value 由模块内 WeakSet 认证。
- Produces: internal `getTrustedCompilerInput(value): CompilerInputV1 | undefined`，不从 package root 导出。

- [x] **Step 1: 写 Projector 来源和闭包失败测试**

```ts
const manualPlaywrightSourceArtifact = {
  artifactType: 'playwright-source',
  sourceFiles: [{ relativePath: 'tests/manual.spec.ts', bytes: 'process.env.HOME' }],
}
const projected = projectCompilerInputFromArtifacts({ artifacts: approvedArtifactFixture(), playwrightVersion: '1.61.1' })
expect(readCompilerInputForTest(projected)).toMatchObject({
  schemaVersion: 'compiler-input/v1', testDomain: undefined,
  cases: [{ caseId: 'CASE-1', actions: [{ kind: 'assertText', actionId: 'ACTION-1' }] }],
})

expect(() => projectCompilerInputFromArtifacts({
  artifacts: [...approvedArtifactFixture(), { ...manualPlaywrightSourceArtifact }],
  playwrightVersion: '1.61.1',
} as any)).toThrow(/E2E_COMPILER_CODE_FIELD_REJECTED|E2E_COMPILER_INPUT_INVALID/)
```

补充以下失败：不同 generation/PRD、重复 Artifact type、缺失 action、未知 effect、Case/obligation 不闭合、执行队列不闭合、写 Case 缺 Lease/Cleanup、人工 source/config/import 字段。

- [x] **Step 2: 运行 Projector 测试并确认 RED**

Run: `npx vitest run packages/e2e-playwright-runtime/test/compiler-input-projector.test.ts`

Expected: FAIL，模块不存在。

- [x] **Step 3: 实现严格 Projector**

```ts
export interface ProjectCompilerInputFromArtifactsRequest {
  artifacts: unknown[]
  playwrightVersion: string
}

export interface TrustedCompilerInput {}

export function projectCompilerInputFromArtifacts(
  request: ProjectCompilerInputFromArtifactsRequest,
): TrustedCompilerInput
```

Projector 必须逐份调用 `parseArtifactDocument`，要求七种 Artifact 各且仅一份，并验证相同 assetId/generationId/prdRevision。read Action 从冻结 locator/oracle 投影为数据字段；reversible-write 从 Action Map、Case dataNeed/cleanup 和 Oracle 投影。`playwrightAction` 永远不复制到 Compiler Input；无法映射时生成 blocked disposition，不回退到源码。

- [x] **Step 4: 收紧 Compiler 可见性**

从 package root 移除 `compileReadOnlyProject`、`ReadOnlyCompiledCase` 等低层导出。Compiler 文件只接受经 `getTrustedCompilerInput` 认证的 opaque input；测试若需验证模板，通过 Projector 构造输入，不再直接传任意 typed Case。

- [x] **Step 5: 运行 Runtime Projector/Compiler 测试并确认 GREEN**

Run: `npx vitest run packages/e2e-playwright-runtime/test/compiler-input-projector.test.ts packages/e2e-playwright-runtime/test/compiler.test.ts`

Expected: PASS。

- [x] **Step 6: 记录提交检查点（不执行 Git 写操作）**

Checkpoint message: `feat(e2e): project trusted compiler input from approved artifacts`

---

### Task 3: Fresh Root、Source Set 枚举与篡改拒绝

**Files:**
- Create: `packages/e2e-playwright-runtime/src/regression-source-set.ts`
- Create: `packages/e2e-playwright-runtime/test/regression-source-set.test.ts`
- Modify: `packages/e2e-playwright-runtime/src/compiler.ts`
- Modify: `packages/e2e-playwright-runtime/src/regression-discovery.ts`
- Modify: `packages/e2e-playwright-runtime/test/compiler.test.ts`
- Modify: `packages/e2e-playwright-runtime/test/regression-discovery.test.ts`

**Interfaces:**
- Produces: `readRegressionSourceSet(root, prefix): Promise<AttestedRegressionFile[]>`。
- Produces: `assertFreshOutputRoot(root): Promise<void>`。
- Consumes: Compiler 固定 `generatedFiles` 白名单与 `digestBytes('generation-file:<path>')`。

- [x] **Step 1: 写文件系统攻击的失败测试**

```ts
await writeFile(join(root, 'preexisting.ts'), 'evil')
await expect(compileTrustedProject({ outputDir: root, compilerInput })).rejects.toThrow('E2E_COMPILER_OUTPUT_NOT_FRESH')

await symlink(outside, join(root, 'tests', 'linked.spec.ts'))
await expect(readRegressionSourceSet(root, 'regression')).rejects.toThrow('E2E_COMPILER_PATH_ESCAPE')

await writeFile(join(result.projectDir, 'tests', 'manual.spec.ts'), "test('CASE-FAKE',()=>{})")
await expect(rediscover(result)).rejects.toThrow('E2E_COMPILER_UNATTESTED_SOURCE')
```

- [x] **Step 2: 运行定向测试并确认 RED**

Run: `npx vitest run packages/e2e-playwright-runtime/test/regression-source-set.test.ts packages/e2e-playwright-runtime/test/regression-discovery.test.ts`

Expected: FAIL，现有 Discovery 不枚举额外文件且 Compiler 接受非空根。

- [x] **Step 3: 实现安全枚举和排他写**

枚举使用 `readdir(..., { withFileTypes: true })` + `lstat`，按 canonical relative path 排序；拒绝 symlink、非普通文件、路径逃逸和超限文件数。Compiler 写文件使用 `open(path, 'wx')`，输出根必须已存在、为空、非链接，生成失败清理已写文件但不删除调用方父目录。

- [x] **Step 4: Discovery 从磁盘实际集合复验**

Discovery 不再遍历 Compiler 返回的文件名作为事实来源，而是枚举全目录，然后要求：

```ts
sameStrings(actualPaths, compiled.generatedFiles)
&& everyActualDigestMatchesCompilerDigest
&& sourceSetDigest === computeRegressionSourceSetDigest(sourceFiles)
```

额外/缺失/修改文件统一 fail closed，错误码区分 source set mismatch 与 path escape。

- [x] **Step 5: 运行 Runtime 测试并确认 GREEN**

Run: `npx vitest run packages/e2e-playwright-runtime/test/compiler.test.ts packages/e2e-playwright-runtime/test/regression-source-set.test.ts packages/e2e-playwright-runtime/test/regression-discovery.test.ts`

Expected: PASS。

- [x] **Step 6: 记录提交检查点（不执行 Git 写操作）**

Checkpoint message: `fix(e2e): seal compiler output and attest exact source set`

---

### Task 4: 执行前 Source Set 复验与不可伪造会话

**Files:**
- Create: `packages/e2e-playwright-runtime/src/trusted-compiler-execution.ts`
- Create: `packages/e2e-playwright-runtime/test/trusted-compiler-execution.test.ts`
- Modify: `packages/e2e-playwright-runtime/src/index.ts`
- Modify: `packages/e2e-playwright-runtime/src/controlled-write-bridge.ts`
- Modify: `packages/e2e-playwright-runtime/test/controlled-write-bridge.test.ts`

**Interfaces:**
- Produces: `prepareTrustedCompilerRun(request): Promise<TrustedCompilerRunSession>`。
- Produces: `getTrustedCompilerRunBinding(session)`，只返回模块内部 WeakMap 绑定。
- Produces: `createTrustedCompilerControlledWriteLauncher(configurations, session)`。
- Consumes: V2 attestation verifier、磁盘 Source Set、fresh execution approval/run identity。

- [x] **Step 1: 写 TOCTOU 和伪造 session 失败测试**

```ts
const session = await prepareTrustedCompilerRun(validRequest)
expect(getTrustedCompilerRunBinding(session)).toMatchObject({
  testDomain: 'prd-e2e-trusted-compiler', executionProfile: 'trusted-reversible-write',
})

await writeFile(generatedSpec, `${original}\n// tampered`)
await expect(prepareTrustedCompilerRun(validRequest)).rejects.toThrow('E2E_RUN_SOURCE_CHANGED')

expect(() => createTrustedCompilerControlledWriteLauncher(configs, {} as any))
  .toThrow('E2E_CONTROLLED_WRITE_TRUSTED_COMPILER_SESSION_REQUIRED')
```

- [x] **Step 2: 运行定向测试并确认 RED**

Run: `npx vitest run packages/e2e-playwright-runtime/test/trusted-compiler-execution.test.ts packages/e2e-playwright-runtime/test/controlled-write-bridge.test.ts`

Expected: FAIL，新 API 不存在。

- [x] **Step 3: 实现执行前复验**

`prepareTrustedCompilerRun` 必须验证 attestation 专用签名、subject 精确一致、projectDir 实际 Source Set、asset/generation/PRD、compiler input digest、profile、runId、approvalDigest 和工具链。成功返回空对象，并在私有 WeakMap 中保存不可变 binding；调用方构造普通对象无可信语义。

- [x] **Step 4: 新增可信编译写 launcher**

```ts
export function createTrustedCompilerControlledWriteLauncher(
  configurations: ControlledWriteCaseConfiguration[],
  session: TrustedCompilerRunSession,
): ControlledWriteLauncher
```

该入口只接受 `trusted-reversible-write` session、同 asset/generation/PRD/run/approval 的 configuration，并复用现有 `createControlledWriteLauncher`。`createProductionControlledWriteLauncher` 保持原有 production-isolated + authenticated RPC 约束。

- [x] **Step 5: 运行 Runtime 测试并确认 GREEN**

Run: `npx vitest run packages/e2e-playwright-runtime/test/trusted-compiler-execution.test.ts packages/e2e-playwright-runtime/test/controlled-write-bridge.test.ts`

Expected: PASS。

- [x] **Step 6: 记录提交检查点（不执行 Git 写操作）**

Checkpoint message: `feat(e2e): verify attested sources before trusted execution`

---

### Task 5: Engine 按测试域和执行 Profile 审计

**Files:**
- Modify: `packages/e2e-engine/src/generation-audit.ts`
- Modify: `packages/e2e-engine/test/generation-audit.test.ts`
- Modify: `packages/e2e-engine/test/complete-generation.fixture.ts`
- Modify: `packages/e2e-engine/test/complete-generation-builder.test.ts`
- Modify: `packages/e2e-report/test/complete-report.test.ts`

**Interfaces:**
- Consumes: regression manifest/attestation 的 `testDomain`、`executionProfile`、Compiler 与 Source Set provenance。
- Produces: `trusted-reversible-write` 可在 `runtimeIsolation=null` 时通过；`production-isolated` 继续要求 policy digest。
- Produces: ordinary/unattested source findings，阻止其贡献 final verdict。

- [x] **Step 1: 写 Profile 真值表失败测试**

```ts
test.each([
  ['trusted-reversible-write', null, 'not-applicable', true],
  ['production-isolated', productionPolicy, digestRuntimeIsolationPolicy(productionPolicy), true],
  ['production-isolated', null, 'not-applicable', false],
  ['trusted-read-only', productionPolicy, digestRuntimeIsolationPolicy(productionPolicy), false],
])('%s runtime isolation binding', (profile, policy, isolationDigest, valid) => {
  const input = completeWriteGenerationFixture()
  const manifest = input.drafts['regression-manifest'].content as Record<string, unknown>
  const attestation = (manifest.listResult as Record<string, unknown>).attestation as Record<string, unknown>
  manifest.executionProfile = profile
  attestation.executionProfile = profile
  ;(input.drafts['execution-contract'].content as Record<string, unknown>).runtimeIsolation = policy
  ;(input.drafts['run-bundle'].content as Record<string, unknown>).runtimeIsolationPolicyDigest = isolationDigest
  resignRegressionDiscoveryFixture(input)
  refreshFixtureApproval(input)
  const build = () => buildCompleteGeneration(input)
  if (valid) expect(build).not.toThrow()
  else expect(build).toThrow()
})
```

另写失败测试：`testDomain=ordinary`、manifest 与 attestation profile 不同、缺 Compiler Input digest、人工 Case ID 注入 regression list、V1 attestation。

- [x] **Step 2: 运行 Engine/Report 定向测试并确认 RED**

Run: `npx vitest run packages/e2e-engine/test/generation-audit.test.ts packages/e2e-engine/test/complete-generation-builder.test.ts packages/e2e-report/test/complete-report.test.ts`

Expected: FAIL，现有逻辑对所有非 read Action 强制 runtime isolation，且不识别 testDomain。

- [x] **Step 3: 实现 Profile 审计**

```ts
if (profile === 'production-isolated') requireBoundRuntimeIsolation()
else if (profile === 'trusted-read-only' || profile === 'trusted-reversible-write') requireNoRuntimeIsolation()
else add('E2E_COMPILER_UNATTESTED_SOURCE', 'regression-manifest', 'executionProfile')
```

同时要求 manifest 与 attestation 的 domain/profile 相等；只有 `prd-e2e-trusted-compiler` Case mappings 能进入 regressionDetails 和 verdict facts。ordinary/manual Playwright 结果只能走既有 manual/ordinary 报告路径。

- [x] **Step 4: 更新 V2 fixture 与报告断言**

Fixture 必须真实计算 V2 subject digest/signature，不得用类型断言伪造缺失字段。报告测试确认 profile 可见且不会误称 `production-isolated`。

- [x] **Step 5: 运行 Engine/Report 测试并确认 GREEN**

Run: `npx vitest run packages/e2e-engine/test/generation-audit.test.ts packages/e2e-engine/test/complete-generation-builder.test.ts packages/e2e-report/test/complete-report.test.ts`

Expected: PASS。

- [x] **Step 6: 记录提交检查点（不执行 Git 写操作）**

Checkpoint message: `feat(e2e): audit trusted compiler profiles and ordinary test isolation`

---

### Task 6: 真实 Golden 主链改用 Artifact Projector

**Files:**
- Modify: `scripts/e2e-read-only-generation.ts`
- Modify: `scripts/e2e-read-only.golden.test.ts`
- Modify: `scripts/e2e-write.golden.test.ts`
- Create: `scripts/e2e-trusted-compiler-boundary.golden.test.ts`
- Modify: `vitest.e2e.config.ts`（仅在现有 glob 无法自动发现时）

**Interfaces:**
- Consumes: 已审批 Artifact documents、`projectCompilerInputFromArtifacts`、Discovery V2、`prepareTrustedCompilerRun`。
- Produces: read/write 真实 Chromium、Gateway、Cleanup、Evidence、Report 闭环。

- [x] **Step 1: 写边界 Golden 的失败断言**

Golden 必须覆盖：

```ts
await expect(discovery.compileAndAttest({ ...valid, sourceFiles: [evil] } as any))
  .rejects.toThrow('E2E_REGRESSION_DISCOVERY_INPUT_INVALID')
await expect(prepareTrustedCompilerRun(tamperedProject)).rejects.toThrow('E2E_RUN_SOURCE_CHANGED')
expect(finalReport.content.regressionDetails).toMatchObject({
  testDomain: 'prd-e2e-trusted-compiler',
  executionProfile: 'trusted-reversible-write',
})
```

- [x] **Step 2: 运行 Golden 并确认 RED**

Run: `npm run e2e:golden`

Expected: 新边界 Golden FAIL；旧 Golden 的 V1 调用在迁移完成前也会 FAIL。

- [x] **Step 3: 将只读 Golden 接入 Projector + preflight**

从同代 Artifact documents 投影 input，Discovery 生成 V2 证明，启动真实 Chromium 前执行 Source Set 复验；最终 generation 使用同一 attestation/files。

- [x] **Step 4: 将可逆写 Golden 接入 trusted-reversible-write**

移除该 Golden 对 production isolation attestation 的核心依赖，改用可信编译 run session + RunGate/Bridge/Gateway/Lease/Cleanup；保留独立 production isolation 单元测试，证明更高 Profile 未被删除。

- [x] **Step 5: 运行 Golden 并确认 GREEN**

Run: `npm run e2e:golden`

Expected: 所有 Golden PASS，真实 Chromium、Gateway、证据和清理仍被执行。

- [x] **Step 6: 记录提交检查点（不执行 Git 写操作）**

Checkpoint message: `test(e2e): prove declarative compiler boundary in real browser golden`

---

### Task 7: 中文 Skill、Schema 快照与全量验证

**Files:**
- Modify: `packages/skills/skills/testing/e2e/SKILL.md`
- Modify: `packages/skills/skills/testing/e2e/regression-publication.md`
- Modify: `packages/skills/skills/testing/e2e/safety-gateway.md`
- Modify: `packages/skills/test/e2e-skill.test.ts`
- Modify generated: `packages/e2e-contracts/schemas/current.json`
- Create generated set: `packages/e2e-contracts/schemas/sets/<digest>/*.schema.json`

**Interfaces:**
- Consumes: 已实现的唯一公共入口、错误码、测试域和执行 Profile。
- Produces: 中文操作规范、可分发 JSON Schema 和最终验证证据。

- [x] **Step 1: 写 Skill 文档失败测试**

```ts
expect(regression).toContain('regression-discovery-attestation/v2')
expect(regression).toContain('prd-e2e-trusted-compiler')
expect(regression).toContain('人工 Playwright')
expect(regression).toContain('不得进入可信报告')
expect(safety).toContain('trusted-reversible-write')
expect(safety).not.toContain('可信可逆写必须取得生产隔离证明')
```

- [x] **Step 2: 运行 Skill 测试并确认 RED**

Run: `npx vitest run packages/skills/test/e2e-skill.test.ts`

Expected: FAIL，文档仍描述 V1/强制生产隔离。

- [x] **Step 3: 更新中文 Skill 文档**

明确：AI 只生成声明式 Artifact；Compiler/Discovery 唯一入口；人工 Playwright 属于普通测试域；trusted reversible write 与 production isolated 的区别；页面流量零绕过仍要求外部 Egress Guard。

- [x] **Step 4: 生成并验证 Schema 快照**

Run: `npm run generate:e2e-schemas`

Expected: 创建新的内容寻址 schema set，`current.json` 指向新集合，重复运行无 diff。

- [x] **Step 5: 执行全量验证**

Run: `npm run typecheck`

Expected: PASS。

Run: `npm test`

Expected: PASS，不增加 skip/fixme/todo。

Run: `npm run lint:architecture`

Expected: PASS。

Run: `npm run e2e:golden`

Expected: PASS。

Run: `git diff --check`

Expected: 无输出且 exit code 0。

- [x] **Step 6: 对照 Spec Definition of Done 做最终审计**

逐项核对 `docs/superpowers/specs/2026-07-15-declarative-e2e-compiler-trust-boundary-design.md` 第 20 节；若任何项缺少代码或测试证据，不得声称完成。

- [x] **Step 7: 记录最终提交检查点（不执行 Git 写操作）**

Checkpoint message: `feat(e2e): enforce declarative trusted compiler acceptance chain`
