# Portable E2E Runtime Host Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将现有只能在 `mutil-skills` 源码仓库组合运行的 E2E 能力产品化为用户级隔离 Runtime Host，使 E2E Skill 能在任意用户项目中通过稳定入口完成 PRD→浏览器验收→可追踪资产→报告闭环。

**Architecture:** 新增 `@mutil-skills/e2e-runtime` 深模块和 `repo-e2e` 稳定命令，Runtime 版本化安装到用户目录，并在独立进程中托管 Authority、Gateway 与受控 Chromium。Skill 只提交严格 JSON 候选；权威执行由固定 Runner 解释声明式 Action，不加载生成源码；生成的 Playwright 仅作为经过审计的发布资产。

**Tech Stack:** TypeScript 5.8、Node.js 24、Zod 3.25、Vitest 3.2、Playwright 1.61.1、Mockttp 4.4.2、SimpleWebAuthn Server 13.3.2 / Browser 13.3.0、现有 SQLite/Ed25519/AES-256-GCM/POSIX 文件系统 helper。

## Global Constraints

- Runtime 协议版本固定为 `1.0.0`；不兼容 major 必须返回 `migration-required`。
- 首个发布闭包中七个 E2E 包版本固定为 `0.1.0`，内部依赖必须使用精确版本。
- 稳定入口固定为 `~/.mutil-skills/bin/repo-e2e`；Runtime 不得从用户项目 `node_modules`、cwd、`NODE_PATH`、loader 或 tsconfig path 解析可执行依赖。
- Runtime、state、Authority、quarantine、logs 的目录权限必须为 `0700`，敏感普通文件必须为 `0600`；只支持 macOS/Linux。
- Runtime/Chromium 安装必须显式、精确版本；不得静默联网或使用 `latest`。
- 权威 E2E 执行不得 import 或运行生成的 Playwright/Node.js 源码；固定 Runner 只解释已审批 Action Map。
- Authority 与 Gateway 必须是独立子进程；所有本地服务只绑定 loopback，并使用认证 session。
- RPC JSON 中的 `approved: true` 不构成审批；生产审批必须经过 WebAuthn user verification。
- 子进程 env 从空对象构建；不得继承 SSH、云凭证、项目 `.env`、`NODE_OPTIONS` 或 `NODE_PATH`。
- 浏览器目标流量必须经过 Gateway；无法证明强制代理时返回 `safety-blocked`。
- raw evidence、密钥、浏览器 profile 和未完成 Run state 只能位于 `~/.mutil-skills/e2e/`；项目 `.biztest` 只允许已脱敏同代资产。
- `doctor` 只探测，不安装、不下载、不执行 Case、不保留 canary Run。
- 所有行为变化严格执行 RED→GREEN；每个任务结束时运行该任务的定向测试、typecheck/architecture 检查并创建原子提交。
- 最终只构建和本地 pack，不发布 registry、不创建 tag、不推送远端。
- WebAuthn 依据 [SimpleWebAuthn Server 官方文档](https://simplewebauthn.dev/docs/packages/server)，固定使用 `@simplewebauthn/server@13.3.2` 和 `@simplewebauthn/browser@13.3.0`；RP ID 为 `localhost`，registration/authentication 均要求 user verification。
- HTTPS/WebSocket 代理依据 [Mockttp 官方 API](https://httptoolkit.github.io/mockttp/interfaces/Mockttp.html)，固定使用 `mockttp@4.4.2`；生产逻辑必须使用 HTTPS interception、显式 request/WebSocket rule 和 fallback deny。

---

## 文件结构映射

### 新包

- `packages/e2e-runtime/package.json`：Runtime 发布闭包、`repo-e2e` bin 和精确生产依赖。
- `packages/e2e-runtime/src/protocol.ts`：协议解码、response 编码和退出码。
- `packages/e2e-runtime/src/runtime-layout.ts`：用户级/项目级布局、owner、mode、realpath 与 no-follow。
- `packages/e2e-runtime/src/runtime-installer.ts`：精确版本 staging 安装、manifest、原子 current 切换和恢复。
- `packages/e2e-runtime/src/runtime-discovery.ts`：固定 launcher 解析、安装闭包验签和 source independence。
- `packages/e2e-runtime/src/runtime-doctor.ts`：全部 capability probe 和结构化 remediation。
- `packages/e2e-runtime/src/process-supervisor.ts`：绝对入口、最小 env、超时、shutdown 和 kill fallback。
- `packages/e2e-runtime/src/environment-policy.ts`：子进程 env allowlist 和禁止项。
- `packages/e2e-runtime/src/run-store.ts`：用户级 Run snapshot、requestId 幂等和恢复。
- `packages/e2e-runtime/src/project-identity.ts`：真实项目根、dev/inode 和 rebind。
- `packages/e2e-runtime/src/authority-host.ts`：Authority/WebAuthn 生命周期适配。
- `packages/e2e-runtime/src/secret-broker.ts`：隐藏输入、Keychain/Secret Service 与一次性 secret handle。
- `packages/e2e-runtime/src/gateway-proxy-host.ts`：Mockttp 父进程 handle、policy 安装和审计。
- `packages/e2e-runtime/src/gateway-proxy-host-process.ts`：独立 HTTPS/WebSocket proxy 子进程。
- `packages/e2e-runtime/src/browser-host.ts`：固定 Chromium 参数、Gateway canary 和 Browser session。
- `packages/e2e-runtime/src/trusted-action-runner.ts`：声明式只读/写入/注入执行。
- `packages/e2e-runtime/src/runtime-host.ts`：唯一应用入口和 Engine 状态协调。
- `packages/e2e-runtime/src/generation-assembler.ts`：已验证候选、执行事实、脱敏证据到完整 generation。
- `packages/e2e-runtime/src/project-publisher.ts`：现有 Artifact Store 的受控发布适配。
- `packages/e2e-runtime/src/cli.ts`、`src/bin/repo-e2e.ts`：人类命令和机器 RPC 的同一入口。
- `packages/e2e-runtime/assets/approval/`：本地 WebAuthn 审批静态页，不引用 CDN。
- `packages/e2e-runtime/test/`：协议、安装、Host、安全与跨进程集成测试。

### 修改现有模块

- `packages/e2e-contracts/src/runtime-host.ts`：Runtime request/result/doctor/install provenance Schema。
- `packages/e2e-contracts/src/artifacts.ts`：generation/report Runtime provenance。
- `packages/e2e-authority/src/*`：WebAuthn identity/session、独立审批 UI 和进程控制。
- `packages/e2e-gateway/src/*`：把现有 policy/audit 组合接口暴露给代理 Host，不加入 socket server。
- `packages/e2e-playwright-runtime/src/*`：固定 Action Runner 使用的 browser adapter、Compiler 只发布不参与权威事实。
- `packages/schema/src/index.ts` 与 JSON Schema：`e2e.runtime-host` / `prompt-install`。
- `packages/skills/skills/testing/e2e/*`：稳定 CLI/JSON 协议和 docs-only 恢复说明。
- 根 `tsconfig*`、`vitest.config.ts`、`scripts/check-architecture.mjs`：新 workspace 的引用和依赖方向。
- `scripts/e2e-runtime-cross-repo.golden.test.ts`：空白用户项目 tarball Golden。
- `README.md`、`CHANGELOG.md`：安装/升级/能力边界与 `0.1.0` 用户影响。

---

### Task 1: Runtime Protocol 与 Workspace 骨架

**Files:**
- Create: `packages/e2e-contracts/src/runtime-host.ts`
- Create: `packages/e2e-contracts/test/runtime-host.test.ts`
- Modify: `packages/e2e-contracts/src/index.ts`
- Create: `packages/e2e-runtime/package.json`
- Create: `packages/e2e-runtime/tsconfig.json`
- Create: `packages/e2e-runtime/src/index.ts`
- Create: `packages/e2e-runtime/src/protocol.ts`
- Create: `packages/e2e-runtime/src/cli.ts`
- Create: `packages/e2e-runtime/src/bin/repo-e2e.ts`
- Create: `packages/e2e-runtime/test/protocol.test.ts`
- Create: `packages/e2e-runtime/test/fixtures.ts`
- Modify: `tsconfig.base.json`
- Modify: `tsconfig.json`
- Modify: `vitest.config.ts`
- Modify: `scripts/check-architecture.mjs`
- Modify: `package-lock.json`

**Interfaces:**
- Produces: `RuntimeRequestEnvelopeSchema`、`RuntimeResponseEnvelopeSchema`、`RuntimeDoctorReportSchema`、`parseRuntimeRequest()`、`runtimeErrorResponse()`、`exitCodeForResponse()`。
- Produces test helper: `createRuntimeTestRoots(): Promise<{ root: string; home: string; project: string; source: string }>`。
- Consumes: `WorkflowNodeSchema`、`ArtifactTypeSchema`、`E2EError`、`canonicalizeJson()`。

- [ ] **Step 1: 写协议严格性失败测试**

```ts
import { describe, expect, test } from 'vitest'
import { RuntimeRequestEnvelopeSchema } from '../src/runtime-host.js'

const doctorRequest = {
  schemaVersion: '1.0.0',
  requestId: 'REQ-1',
  client: { name: 'e2e-skill', version: '0.1.0' },
  command: 'doctor',
  payload: {},
}

describe('Runtime Host contracts', () => {
  test('accepts the exact doctor envelope', () => {
    expect(RuntimeRequestEnvelopeSchema.parse(doctorRequest)).toEqual(doctorRequest)
  })

  test('rejects extra fields and unsupported protocol major', () => {
    expect(RuntimeRequestEnvelopeSchema.safeParse({ ...doctorRequest, shell: 'rm -rf /' }).success).toBe(false)
    expect(RuntimeRequestEnvelopeSchema.safeParse({ ...doctorRequest, schemaVersion: '2.0.0' }).success).toBe(false)
  })

  test('rejects approval booleans in machine payloads', () => {
    expect(RuntimeRequestEnvelopeSchema.safeParse({
      ...doctorRequest,
      command: 'open-approval',
      projectRoot: '/tmp/project',
      payload: { runId: 'RUN-1', approvalType: 'execution', approved: true },
    }).success).toBe(false)
  })
})
```

- [ ] **Step 2: 运行协议测试并确认 RED**

Run: `npx vitest run packages/e2e-contracts/test/runtime-host.test.ts`

Expected: FAIL，提示 `../src/runtime-host.js` 不存在。

- [ ] **Step 3: 实现完整 request/response Schema**

```ts
import { z } from 'zod'
import { ArtifactTypeSchema } from './artifacts.js'
import { WorkflowNodeSchema } from './workflow.js'

const SafeIdSchema = z.string().min(1).max(256).regex(/^[A-Za-z0-9._:-]+$/)
const DigestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/)
const EmptySchema = z.object({}).strict()
const RunIdPayloadSchema = z.object({ runId: SafeIdSchema }).strict()

const RuntimeRequestHeaderShape = {
  schemaVersion: z.literal('1.0.0'),
  requestId: SafeIdSchema,
  client: z.object({ name: SafeIdSchema, version: z.string().regex(/^\d+\.\d+\.\d+$/) }).strict(),
}

const commandSchemas = [
  z.object({ ...RuntimeRequestHeaderShape, command: z.literal('doctor'), payload: EmptySchema }).strict(),
  z.object({
    ...RuntimeRequestHeaderShape,
    command: z.literal('create-run'),
    projectRoot: z.string().min(1),
    payload: z.object({
      assetId: SafeIdSchema,
      prdSource: z.object({ kind: z.literal('file'), path: z.string().min(1) }).strict(),
      projectPolicyPath: z.string().min(1),
    }).strict(),
  }).strict(),
  z.object({
    ...RuntimeRequestHeaderShape,
    command: z.literal('submit-candidate'),
    projectRoot: z.string().min(1),
    payload: z.object({
      runId: SafeIdSchema,
      expectedState: WorkflowNodeSchema,
      artifactType: ArtifactTypeSchema,
      candidate: z.unknown(),
    }).strict(),
  }).strict(),
  z.object({
    ...RuntimeRequestHeaderShape,
    command: z.literal('open-approval'),
    projectRoot: z.string().min(1),
    payload: z.object({
      runId: SafeIdSchema,
      approvalType: z.enum(['scope', 'lineage', 'discovery', 'execution', 'privacy']),
    }).strict(),
  }).strict(),
  z.object({
    ...RuntimeRequestHeaderShape,
    command: z.literal('execute-run'), projectRoot: z.string().min(1), payload: RunIdPayloadSchema,
  }).strict(),
  z.object({
    ...RuntimeRequestHeaderShape,
    command: z.literal('resume-run'),
    projectRoot: z.string().min(1),
    payload: z.object({ runId: SafeIdSchema, decision: z.unknown() }).strict(),
  }).strict(),
  z.object({
    ...RuntimeRequestHeaderShape,
    command: z.literal('get-status'), projectRoot: z.string().min(1), payload: RunIdPayloadSchema,
  }).strict(),
  z.object({
    ...RuntimeRequestHeaderShape,
    command: z.literal('render-report'), projectRoot: z.string().min(1), payload: RunIdPayloadSchema,
  }).strict(),
] as const

export const RuntimeRequestEnvelopeSchema = z.discriminatedUnion('command', commandSchemas)

export const RuntimeErrorSchema = z.object({
  code: z.string().regex(/^E2E_[A-Z0-9_]+$/),
  category: z.enum(['input', 'environment', 'safety', 'automation', 'artifact', 'migration', 'internal']),
  terminalState: z.enum([
    'input-blocked', 'environment-blocked', 'safety-blocked',
    'automation-blocked', 'artifact-blocked', 'migration-required',
  ]),
  message: z.string().min(1),
  retryable: z.boolean(),
  resumeState: WorkflowNodeSchema.optional(),
  details: z.record(z.unknown()).optional(),
}).strict()

export const RuntimeDoctorProbeSchema = z.object({
  status: z.enum(['passed', 'blocked', 'not-installed']),
  reasonCode: z.string().regex(/^E2E_[A-Z0-9_]+$/),
  proofDigest: DigestSchema.optional(),
  remediation: z.string().min(1),
}).strict()

export const RuntimeDoctorReportSchema = z.object({
  ready: z.boolean(),
  runtimeVersion: z.string().regex(/^\d+\.\d+\.\d+$/),
  installationDigest: DigestSchema,
  probes: z.record(RuntimeDoctorProbeSchema),
}).strict()

export const RuntimeResponseEnvelopeSchema = z.object({
  schemaVersion: z.literal('1.0.0'),
  requestId: SafeIdSchema,
  runtime: z.object({ version: z.string().regex(/^\d+\.\d+\.\d+$/), installationDigest: DigestSchema }).strict(),
  ok: z.boolean(),
  result: z.unknown().optional(),
  error: RuntimeErrorSchema.optional(),
}).strict().superRefine((value, context) => {
  if (value.ok === (value.error !== undefined) || value.ok !== (value.result !== undefined)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'response 必须且只能包含 result 或 error' })
  }
})

export type RuntimeRequestEnvelope = z.infer<typeof RuntimeRequestEnvelopeSchema>
export type RuntimeResponseEnvelope = z.infer<typeof RuntimeResponseEnvelopeSchema>
```

同时从 `packages/e2e-contracts/src/index.ts` 导出 `runtime-host.js`。

- [ ] **Step 4: 创建 Runtime workspace 与最小 CLI 协议适配器**

`packages/e2e-runtime/package.json` 初始版本保持与当前内部包一致的 `0.0.0`，最终任务统一升级：

```json
{
  "name": "@mutil-skills/e2e-runtime",
  "version": "0.0.0",
  "type": "module",
  "files": ["dist/src", "assets"],
  "bin": { "repo-e2e": "./dist/src/bin/repo-e2e.js" },
  "exports": {
    ".": { "types": "./dist/src/index.d.ts", "import": "./dist/src/index.js" }
  },
  "scripts": { "test": "vitest run" },
  "dependencies": {
    "@mutil-skills/e2e-authority": "0.0.0",
    "@mutil-skills/e2e-contracts": "0.0.0",
    "@mutil-skills/e2e-engine": "0.0.0",
    "@mutil-skills/e2e-gateway": "0.0.0",
    "@mutil-skills/e2e-playwright-runtime": "0.0.0",
    "@mutil-skills/e2e-report": "0.0.0"
  }
}
```

`src/index.ts` 只导出协议函数，不导出 Host/Authority/Gateway 构造器：

```ts
export { parseRuntimeRequest, runtimeErrorResponse, exitCodeForResponse } from './protocol.js'
```

`src/bin/repo-e2e.ts`：

```ts
#!/usr/bin/env node
import { runCli } from '../cli.js'

const exitCode = await runCli(process.argv.slice(2), process.stdin, process.stdout, process.stderr)
process.exitCode = exitCode
```

`src/protocol.ts` 必须用 `RuntimeRequestEnvelopeSchema.safeParse()`，把 JSON/Schema 错误映射为 `E2E_RUNTIME_REQUEST_INVALID`，并按 Spec 映射退出码 0/2/3/4/5/70。`src/cli.ts` 首片只实现 `--version` 与 `rpc` 解码；合法但尚未具备 Host 的命令统一返回 `E2E_RUNTIME_NOT_INSTALLED`/`environment-blocked`，不得抛 stack。

- [ ] **Step 5: 接入 workspace 引用和架构规则**

在根 `tsconfig.base.json`/`vitest.config.ts` 增加 `@mutil-skills/e2e-runtime` alias，在根 `tsconfig.json` 增加 project reference，在 `assertWorkspacePackages()` 增加 `e2e-runtime`。新增架构检查：`packages/skills/src` 和 `packages/skills/skills` 不得出现 `@mutil-skills/e2e-*` import；低层 E2E 包不得 import `@mutil-skills/e2e-runtime`。

Run: `npm install --package-lock-only`

Expected: lockfile登记 `packages/e2e-runtime`，不下载 Chromium。

- [ ] **Step 6: 运行 GREEN 验证**

Run: `npx vitest run packages/e2e-contracts/test/runtime-host.test.ts packages/e2e-runtime/test/protocol.test.ts`

Expected: PASS。

Run: `npm run typecheck && npm run lint:architecture`

Expected: PASS。

- [ ] **Step 7: 提交协议和 package 骨架**

```bash
git add packages/e2e-contracts packages/e2e-runtime tsconfig.base.json tsconfig.json vitest.config.ts scripts/check-architecture.mjs package-lock.json
git commit -m "feat(e2e): add runtime host protocol"
```

---

### Task 2: 版本化安装、固定 Launcher 与 Source Independence

**Files:**
- Create: `packages/e2e-runtime/src/runtime-layout.ts`
- Create: `packages/e2e-runtime/src/runtime-manifest.ts`
- Create: `packages/e2e-runtime/src/runtime-installer.ts`
- Create: `packages/e2e-runtime/src/runtime-uninstaller.ts`
- Create: `packages/e2e-runtime/src/runtime-discovery.ts`
- Create: `packages/e2e-runtime/src/launcher-template.ts`
- Create: `packages/e2e-runtime/test/runtime-layout.test.ts`
- Create: `packages/e2e-runtime/test/runtime-installer.test.ts`
- Create: `packages/e2e-runtime/test/runtime-uninstaller.test.ts`
- Create: `packages/e2e-runtime/test/runtime-discovery.test.ts`
- Modify: `packages/e2e-runtime/src/cli.ts`
- Modify: `packages/e2e-runtime/src/index.ts`

**Interfaces:**
- Consumes: Task 1 协议和 `createRuntimeTestRoots()`。
- Produces: `runtimeLayout(homeDir)`、`installRuntime(options)`、`uninstallRuntime(options)`、`inspectRuntimeInstallation(options)`、`RuntimeInstallation`。
- Produces injection seam: `ProductionClosureInstaller.install({ prefix, packageSpec, env }): Promise<void>`；单测不得联网。

- [ ] **Step 1: 写安装安全与原子切换失败测试**

```ts
import { chmod, mkdir, readFile, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { createRuntimeTestRoots } from './fixtures.js'
import { installRuntime } from '../src/runtime-installer.js'
import { uninstallRuntime } from '../src/runtime-uninstaller.js'

describe('versioned runtime installer', () => {
  test('installs an exact closure and switches current atomically', async () => {
    const roots = await createRuntimeTestRoots()
    const source = join(roots.source, 'prepared-prefix')
    await mkdir(join(source, 'node_modules', '@mutil-skills', 'e2e-runtime', 'dist', 'src', 'bin'), { recursive: true })
    await writeFile(join(source, 'node_modules', '@mutil-skills', 'e2e-runtime', 'package.json'),
      JSON.stringify({ name: '@mutil-skills/e2e-runtime', version: '0.0.0' }))
    await writeFile(join(source, 'node_modules', '@mutil-skills', 'e2e-runtime', 'dist', 'src', 'bin', 'repo-e2e.js'),
      '#!/usr/bin/env node\n')

    const result = await installRuntime({
      homeDir: roots.home,
      version: '0.0.0',
      installClosure: async ({ stagingPrefix }) => {
        const { cp } = await import('node:fs/promises')
        await cp(source, stagingPrefix, { recursive: true })
      },
    })

    expect(result.version).toBe('0.0.0')
    expect(JSON.parse(await readFile(join(roots.home, '.mutil-skills/runtime/e2e/current.json'), 'utf8')))
      .toMatchObject({ runtimeVersion: '0.0.0', protocolMajor: 1 })
  })

  test('rejects an unowned root and symlinked version directory', async () => {
    const roots = await createRuntimeTestRoots()
    const runtimeRoot = join(roots.home, '.mutil-skills/runtime/e2e')
    await mkdir(runtimeRoot, { recursive: true })
    await writeFile(join(runtimeRoot, 'foreign.txt'), 'keep')
    await expect(installRuntime({ homeDir: roots.home, version: '0.0.0', installClosure: async () => undefined }))
      .rejects.toThrow(/E2E_RUNTIME_ROOT_UNOWNED/)

    const other = join(roots.source, 'other')
    await mkdir(other)
    await mkdir(join(runtimeRoot, 'versions'), { recursive: true })
    await symlink(other, join(runtimeRoot, 'versions', '0.0.0'))
    await chmod(runtimeRoot, 0o700)
  })

  test('never removes the active version without an explicit verified replacement', async () => {
    const roots = await createRuntimeTestRoots()
    const source = join(roots.source, 'active-prefix')
    await mkdir(join(source, 'node_modules', '@mutil-skills', 'e2e-runtime', 'dist', 'src', 'bin'), { recursive: true })
    await writeFile(join(source, 'node_modules', '@mutil-skills', 'e2e-runtime', 'package.json'),
      JSON.stringify({ name: '@mutil-skills/e2e-runtime', version: '0.0.0' }))
    await writeFile(join(source, 'node_modules', '@mutil-skills', 'e2e-runtime', 'dist', 'src', 'bin', 'repo-e2e.js'),
      '#!/usr/bin/env node\n')
    await installRuntime({
      homeDir: roots.home,
      version: '0.0.0',
      installClosure: async ({ stagingPrefix }) => {
        const { cp } = await import('node:fs/promises')
        await cp(source, stagingPrefix, { recursive: true })
      },
    })
    await expect(uninstallRuntime({ homeDir: roots.home, version: '0.0.0' }))
      .rejects.toThrow(/E2E_RUNTIME_ACTIVE_VERSION_REMOVAL_BLOCKED/)
    await expect(uninstallRuntime({
      homeDir: roots.home, version: '0.0.0', activateVersion: '0.0.1',
    })).rejects.toThrow(/E2E_RUNTIME_REPLACEMENT_NOT_VERIFIED/)
  })
})
```

- [ ] **Step 2: 运行安装测试并确认 RED**

Run: `npx vitest run packages/e2e-runtime/test/runtime-installer.test.ts`

Expected: FAIL，提示 installer 模块不存在。

- [ ] **Step 3: 实现固定布局和 manifest 闭包**

```ts
export interface RuntimeLayout {
  root: string
  versions: string
  current: string
  installLock: string
  bin: string
  state: string
  authority: string
  quarantine: string
  logs: string
  browsers: string
}

export function runtimeLayout(homeDir: string): RuntimeLayout {
  const productRoot = join(homeDir, '.mutil-skills')
  const runtimeRoot = join(productRoot, 'runtime', 'e2e')
  return {
    root: runtimeRoot,
    versions: join(runtimeRoot, 'versions'),
    current: join(runtimeRoot, 'current.json'),
    installLock: join(runtimeRoot, 'install.lock'),
    bin: join(productRoot, 'bin', 'repo-e2e'),
    state: join(productRoot, 'e2e', 'state'),
    authority: join(productRoot, 'e2e', 'authority'),
    quarantine: join(productRoot, 'e2e', 'quarantine'),
    logs: join(productRoot, 'e2e', 'logs'),
    browsers: join(runtimeRoot, 'browsers'),
  }
}
```

`runtime-manifest.ts` 必须按 POSIX relative path 排序枚举 version root 内除自身外的全部普通文件；遇到 symlink、socket、device、hardlink count 异常或路径越界即拒绝。每条记录为 `{ path, byteLength, digest }`，根摘要使用 `digestText('e2e-runtime-installation/v1', canonicalizeJson(records))`。

- [ ] **Step 4: 实现安装事务**

`installRuntime()` 必须依次执行 owner/mode 检查、排他锁、同文件系统 staging、精确 package closure 安装、manifest 重算、fsync、rename、`current.json` 原子切换和 launcher 更新。生产 `installClosure` 使用当前 bootstrap 的 `process.execPath + process.env.npm_execpath`，cwd 指向 staging，参数固定为：

```ts
const npmArguments = [
  npmCliPath,
  'install',
  '--ignore-scripts',
  '--omit=dev',
  '--no-audit',
  '--no-fund',
  '--save-exact',
  `@mutil-skills/e2e-runtime@${version}`,
]
```

env 只保留 `HOME`、`PATH`、`TMPDIR`、`npm_config_registry` 和必要 TLS CA 配置；删除 `INIT_CWD`、`NODE_OPTIONS`、`NODE_PATH`、`npm_config_prefix` 与项目 cwd。相同 version 已存在时，只有 installation digest 完全一致才幂等成功。

- [ ] **Step 5: 实现固定 Launcher 与 discovery**

Launcher 读取并严格校验 `current.json`，重算关键入口摘要，确认入口 realpath 位于 version root，然后用 `process.execPath` 和绝对 `dist/src/bin/repo-e2e.js` 启动。`inspectRuntimeInstallation()` 返回：

```ts
export interface RuntimeInstallation {
  version: string
  protocolMajor: 1
  versionRoot: string
  entrypoint: string
  installationDigest: string
  sourceRepositoryIndependent: true
}
```

测试在项目 `node_modules/@mutil-skills/e2e-runtime` 写入会抛错的恶意入口，并设置 `NODE_PATH`；discovery 仍必须解析 temp HOME 下的绝对 version root。

- [ ] **Step 6: 实现显式卸载并接入 CLI**

`uninstallRuntime()` 只接受 exact version；持有同一 `install.lock` 后重新验证 owner marker、目标 version realpath、完整 manifest 和普通文件闭包。目标是 current 时必须同时给出 `activateVersion`，且 replacement 已安装、manifest 有效、协议兼容；先原子切换 `current.json`/launcher，再删除目标目录。默认保留 state、quarantine、authority、logs 和 Chromium；Runtime 卸载接口不得接受删除这些目录的开关。

`repo-e2e uninstall-runtime --version <exact> [--activate <exact>]` 只执行上述版本卸载。raw quarantine 与 Authority identity 的销毁命令不在首发 CLI 实现范围内，CLI 必须明确拒绝把 `--purge-state`、`--purge-quarantine` 或 `--purge-identity` 混入卸载。

- [ ] **Step 7: 接入 CLI 安装命令并验证**

`repo-e2e install-runtime --version <exact>` 调用 installer；缺失/非 exact semver 返回 exit 2。安装成功只输出版本、installation digest 和固定 launcher 路径，不输出 npm cache 路径。

Run: `npx vitest run packages/e2e-runtime/test/runtime-layout.test.ts packages/e2e-runtime/test/runtime-installer.test.ts packages/e2e-runtime/test/runtime-uninstaller.test.ts packages/e2e-runtime/test/runtime-discovery.test.ts`

Expected: PASS。

Run: `npm run typecheck && npm run lint:architecture`

Expected: PASS。

- [ ] **Step 8: 提交安装、卸载与 discovery**

```bash
git add packages/e2e-runtime
git commit -m "feat(e2e): install isolated runtime versions"
```

---

### Task 3: Process Supervisor、最小环境与 Doctor

**Files:**
- Create: `packages/e2e-runtime/src/environment-policy.ts`
- Create: `packages/e2e-runtime/src/process-supervisor.ts`
- Create: `packages/e2e-runtime/src/runtime-doctor.ts`
- Create: `packages/e2e-runtime/test/environment-policy.test.ts`
- Create: `packages/e2e-runtime/test/process-supervisor.test.ts`
- Create: `packages/e2e-runtime/test/runtime-doctor.test.ts`
- Modify: `packages/e2e-runtime/src/cli.ts`
- Modify: `packages/e2e-runtime/src/protocol.ts`

**Interfaces:**
- Consumes: `RuntimeInstallation`、`RuntimeDoctorReportSchema`。
- Produces: `buildChildEnvironment()`、`ProcessSupervisor.spawn()`、`runRuntimeDoctor()`。
- Probe interface: `RuntimeProbe = (context: RuntimeProbeContext) => Promise<RuntimeDoctorProbe>`。

- [ ] **Step 1: 写 env canary 和 Doctor 聚合失败测试**

```ts
import { describe, expect, test } from 'vitest'
import { buildChildEnvironment } from '../src/environment-policy.js'
import { aggregateDoctorReport } from '../src/runtime-doctor.js'

test('child environment drops host and project secrets', () => {
  const env = buildChildEnvironment({
    host: {
      HOME: '/home/user', PATH: '/project/node_modules/.bin:/usr/bin', TMPDIR: '/tmp',
      SSH_AUTH_SOCK: '/tmp/ssh.sock', AWS_SECRET_ACCESS_KEY: 'canary',
      NODE_OPTIONS: '--require /project/hook.js', NODE_PATH: '/project/node_modules',
    },
    runtimeBinPaths: ['/usr/bin'],
    homeDir: '/home/user',
    tempDir: '/tmp/e2e-run',
  })
  expect(env).toEqual({ HOME: '/home/user', LANG: 'C.UTF-8', PATH: '/usr/bin', TMPDIR: '/tmp/e2e-run' })
})

test('doctor is ready only when every required probe passes', () => {
  const report = aggregateDoctorReport({
    runtimeVersion: '0.0.0',
    installationDigest: `sha256:${'a'.repeat(64)}`,
    probes: {
      installation: { status: 'passed', reasonCode: 'E2E_RUNTIME_INSTALLATION_OK', remediation: '无需处理' },
      gateway: { status: 'blocked', reasonCode: 'E2E_GATEWAY_UNAVAILABLE', remediation: '修复 Gateway Runtime' },
    },
  })
  expect(report.ready).toBe(false)
})
```

- [ ] **Step 2: 运行测试并确认 RED**

Run: `npx vitest run packages/e2e-runtime/test/environment-policy.test.ts packages/e2e-runtime/test/runtime-doctor.test.ts`

Expected: FAIL，模块不存在。

- [ ] **Step 3: 实现最小 env 与进程监督器**

`buildChildEnvironment()` 必须从空对象构建，并对 runtime bin path 做 realpath/allowlist；不允许调用方追加任意 env。`ProcessSupervisor.spawn()` 固定接口：

```ts
export interface SupervisedProcessSpec {
  entrypoint: string
  args: string[]
  cwd: string
  env: Record<string, string>
  startTimeoutMs: number
  stopTimeoutMs: number
}

export interface SupervisedProcessHandle {
  pid: number
  requestShutdown(): Promise<void>
  close(): Promise<void>
}
```

实现必须确认 entrypoint realpath 位于 installation version root，使用 `process.execPath` 启动 JS；先 IPC shutdown，超时后 SIGTERM，再超时后返回 `E2E_RUNTIME_CHILD_STOP_TIMEOUT`。不得用 shell。

- [ ] **Step 4: 实现 Doctor probe registry**

`runRuntimeDoctor()` 固定执行并聚合 11 项：installation、version-closure、source-independence、authority、approval-presence、gateway、chromium、isolation、artifact-fs、quarantine、report。尚未进入后续任务的能力必须返回明确 `not-installed`，不能用 `passed` 占位；probe 抛错映射到稳定 reason code，不泄漏 stack。

`doctor --json` stdout 只写 `RuntimeDoctorReportSchema` JSON。普通 `doctor` 在 stderr 输出中文表格，stdout 保持空。

- [ ] **Step 5: 运行 GREEN 验证**

Run: `npx vitest run packages/e2e-runtime/test/environment-policy.test.ts packages/e2e-runtime/test/process-supervisor.test.ts packages/e2e-runtime/test/runtime-doctor.test.ts`

Expected: PASS。

Run: `npm run typecheck && npm run lint:architecture`

Expected: PASS。

- [ ] **Step 6: 提交 Process/Doctor 切片**

```bash
git add packages/e2e-runtime
git commit -m "feat(e2e): add runtime health and process supervision"
```

---

### Task 4: Project Identity、持久 Run Store 与基础 Host 命令

**Files:**
- Create: `packages/e2e-runtime/src/project-identity.ts`
- Create: `packages/e2e-runtime/src/run-store.ts`
- Create: `packages/e2e-runtime/src/runtime-state-migration.ts`
- Create: `packages/e2e-runtime/src/runtime-host.ts`
- Create: `packages/e2e-runtime/test/project-identity.test.ts`
- Create: `packages/e2e-runtime/test/run-store.test.ts`
- Create: `packages/e2e-runtime/test/runtime-state-migration.test.ts`
- Create: `packages/e2e-runtime/test/runtime-host.test.ts`
- Modify: `packages/e2e-runtime/src/cli.ts`
- Modify: `packages/e2e-runtime/src/index.ts`

**Interfaces:**
- Consumes: Task 1 request Schema、Task 2 layout/discovery、Task 3 supervisor/doctor、Engine `createWorkflow()`/`transitionWorkflow()`/`resumeWorkflow()`。
- Produces: `resolveProjectIdentity()`、`RuntimeRunStore.open()`、`migrateRuntimeRunSnapshot()`、`E2ERuntimeHost.handle()`。
- Run snapshot key: `projectIdentityDigest + runId`；request replay key: `requestId + requestDigest`。

- [ ] **Step 1: 写 project copy/replay/状态跳跃失败测试**

```ts
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { createRuntimeTestRoots } from './fixtures.js'
import { resolveProjectIdentity } from '../src/project-identity.js'
import { RuntimeRunStore } from '../src/run-store.js'

test('project identity changes when a project is copied', async () => {
  const roots = await createRuntimeTestRoots()
  await mkdir(join(roots.project, '.biztest'), { recursive: true })
  await writeFile(join(roots.project, '.biztest', 'project.json'),
    JSON.stringify({ schemaVersion: '1.0.0', projectId: 'PROJECT-1' }))
  const first = await resolveProjectIdentity(roots.project)
  const copied = join(roots.root, 'project-copy')
  const { cp } = await import('node:fs/promises')
  await cp(roots.project, copied, { recursive: true })
  const second = await resolveProjectIdentity(copied)
  expect(first.digest).not.toBe(second.digest)
})

test('request id is idempotent but cannot be rebound to other bytes', async () => {
  const roots = await createRuntimeTestRoots()
  const store = await RuntimeRunStore.open({ stateRoot: join(roots.home, '.mutil-skills/e2e/state') })
  const digestA = `sha256:${'a'.repeat(64)}`
  const digestB = `sha256:${'b'.repeat(64)}`
  await store.recordResponse('PROJECT-1', 'RUN-1', 'REQUEST-1', digestA, { ok: true })
  await expect(store.recordResponse('PROJECT-1', 'RUN-1', 'REQUEST-1', digestB, { ok: true }))
    .rejects.toThrow(/E2E_RUNTIME_REQUEST_REPLAY_MISMATCH/)
  await store.close()
})

test('run lock and hash-chained journal fail closed on concurrent or tampered state', async () => {
  const roots = await createRuntimeTestRoots()
  const store = await RuntimeRunStore.open({ stateRoot: join(roots.home, '.mutil-skills/e2e/state') })
  const lock = await store.acquireRunLock('PROJECT-1', 'RUN-1')
  await expect(store.acquireRunLock('PROJECT-1', 'RUN-1')).rejects.toThrow(/E2E_RUNTIME_RUN_LOCKED/)
  await store.appendJournal('PROJECT-1', 'RUN-1', {
    kind: 'run-created', digest: `sha256:${'a'.repeat(64)}`,
  })
  await store.tamperJournalForTest('PROJECT-1', 'RUN-1', 0)
  await expect(store.verifyJournal('PROJECT-1', 'RUN-1'))
    .rejects.toThrow(/E2E_RUNTIME_JOURNAL_INTEGRITY_FAILED/)
  await lock.close()
  await store.close()
})
```

- [ ] **Step 2: 运行测试并确认 RED**

Run: `npx vitest run packages/e2e-runtime/test/project-identity.test.ts packages/e2e-runtime/test/run-store.test.ts`

Expected: FAIL，模块不存在。

- [ ] **Step 3: 实现项目身份和 rebind**

`resolveProjectIdentity()` 必须 realpath 项目根，lstat 逐级拒绝 symlink，读取严格 `.biztest/project.json`，对以下结构做 canonical digest：

```ts
export interface ProjectIdentity {
  realRoot: string
  device: string
  inode: string
  logicalProjectId: string
  digest: string
}
```

digest input 固定为 `{ realRoot, device, inode, logicalProjectId }`，domain 为 `e2e-project-identity/v1`。generation 只保存 digest。`project rebind` 要求 Task 5 的 user-presence receipt；Task 4 先实现内部 `rebindProjectIdentity(input, verifyUserPresence)`，验证回调为 false 时拒绝。

- [ ] **Step 4: 实现 Run Store**

使用 `SqliteSnapshotStore`，state path 必须位于用户级 state root 且显式把项目 root 作为 forbidden root。Run snapshot 严格结构：

```ts
export interface RuntimeRunSnapshot {
  schemaVersion: '1.0.0'
  runId: string
  assetId: string
  projectIdentityDigest: string
  runtimeInstallationDigest: string
  workflow: WorkflowState
  pendingDecision?: PendingWorkflowDecision
  artifactDigests: Record<string, string>
  requestResponses: Record<string, { requestDigest: string; response: unknown }>
  createdAt: string
  updatedAt: string
}
```

每次 mutation 在单个 SQLite exclusive transaction 内完成。Runtime Host 永远忽略调用方自报的 workflow next state，只调用 Engine。

Run lock 使用 SQLite lease row + 进程 nonce，不依赖项目内 lockfile；同一 project/run 任一时刻只允许一个 mutation owner。Journal 每条记录包含严格递增 sequence、previous digest、event digest 和 row digest；启动恢复先验证完整 hash chain，再读取 Authority reservation 和 Artifact Store。任何缺口、重排或摘要不一致均返回 `E2E_RUNTIME_JOURNAL_INTEGRITY_FAILED`，不得尝试修补。`tamperJournalForTest()` 只定义于测试构建条件，不从 Runtime package 导出。

`migrateRuntimeRunSnapshot()` 先解析 snapshot 的 `schemaVersion`。首发只接受当前 `1.0.0` 并 canonical round-trip；未来同 major 迁移必须在显式 registry 中以纯函数逐版本执行、重复执行结果相同，并在写回前保存原摘要。未知版本、缺迁移器或 protocol major 不兼容统一返回 `migration-required`/`E2E_RUNTIME_STATE_MIGRATION_REQUIRED`；active generation 永不因 Runtime 升级被重写。单测覆盖当前版本 round-trip、未知 minor/major 阻塞和迁移器幂等。

- [ ] **Step 5: 实现 Host `create-run/get-status/submit-candidate` 基础链**

```ts
export interface RuntimeHostDependencies {
  installation: RuntimeInstallation
  doctor(): Promise<RuntimeDoctorReport>
  runStore: RuntimeRunStore
  now(): Date
}

export class E2ERuntimeHost {
  constructor(private readonly dependencies: RuntimeHostDependencies) {}
  async handle(request: RuntimeRequestEnvelope): Promise<RuntimeResponseEnvelope> {
    if (request.command === 'doctor') return this.doctorResponse(request)
    if (request.command === 'create-run') return this.createRun(request)
    if (request.command === 'get-status') return this.getStatus(request)
    if (request.command === 'submit-candidate') return this.submitCandidate(request)
    return this.blockedResponse(request, 'E2E_RUNTIME_COMMAND_NOT_READY')
  }
}
```

`submitCandidate()` 先按 `ArtifactSchemaRegistry[artifactType]` 解析，再重算 content digest；candidate 的 assetId、prdRevision、generationId 与当前 Run 不一致即拒绝。每次只允许 Engine 图中的一条合法边。没有对应审批/执行事实时保持原状态并返回最小缺失项。

- [ ] **Step 6: 运行 GREEN 验证**

Run: `npx vitest run packages/e2e-runtime/test/project-identity.test.ts packages/e2e-runtime/test/run-store.test.ts packages/e2e-runtime/test/runtime-state-migration.test.ts packages/e2e-runtime/test/runtime-host.test.ts`

Expected: PASS。

Run: `npm run typecheck && npm run lint:architecture`

Expected: PASS。

- [ ] **Step 7: 提交持久 Host 基础**

```bash
git add packages/e2e-runtime
git commit -m "feat(e2e): persist runtime runs by project identity"
```

---

### Task 5: WebAuthn 用户在场审批与 Authority Host 控制面

> **Spec Errata（2026-07-17，Task 5 外审）**：本节原方案把公开 session 引用、非原子 credential counter 更新、`2.0.0` 同版本加字段和 bearer Cookie 作为实现细节，无法满足不可伪造、并发安全、可迁移和不泄露要求。以下 Task 5 接口与步骤已更正为私有绑定 receipt、insert/CAS、`2.1.0` 事务迁移、fragment + Authorization bearer、单 waiter 有界生命周期、显式 approval type，以及用户在场返回后的项目身份重验；不改变 Task 6 及之后范围。

> **Spec Errata（2026-07-17，Task 5 二次外审）**：旧 snapshot 迁移在 commit 前必须完成严格嵌套解析、全部私钥解密和既有签名校验，错误密钥保持数据库 bytes/revision 不变。六种 Grant 签发入口移除调用方 receipt binding，由已验证的真实 subject 内部派生三字段 binding 并原子消费 receipt。RPC 和人类审批复用完整项目身份断言。Authority 仅在 global replay miss 的新 `open-approval` 中惰性启动；cleanup 独立尝试关闭所有资源并在任何 stdout bytes 写出前决定唯一 response。请求结果已持久化而 cleanup 失败时，本次只返回 cleanup error，后续重放返回持久 success 且仍不启动 Authority；stdout 一旦开始写入，后续写失败不得再写第二 JSON。Authority 状态使用 Runtime 自包含 Python `openat` helper 安全创建目录/密钥，父进程固定只读 final-dir fd，子进程继承 fd 后 `fchdir+exec`，SQLite 用相对 basename 并在打开前后验证目录身份。`@mutil-skills/e2e-runtime` 根导出仅保留协议 Schema、类型和版本。

> **Spec Errata（2026-07-17，Task 5 最终安全审查）**：执行验证必须使用 Host 注册而非 RPC payload 自报的完整 approvalContext，并在 Authority、RPC、Runner、Gateway 四层拒绝跨 Run、跨安装、错类型、错 origin、未来签发和过期回放。`2.0.0/2.1.0` 旧 Grant 因缺少可验证 WebAuthn 上下文，迁移时不得继续授权；先验证旧结构/签名/链，再撤销全部旧 grantId 并清空授权派生状态，要求用户重新审批。WebAuthn/RPC/helper 的原始流 chunk、RPC 长期会话密钥和 PKCS8 明文都必须有可测试的显式清零路径；Authority Host 启动失败后的 child cleanup 若也失败，必须聚合保留两个错误，不能吞掉 cleanup failure。

> **Spec Errata（2026-07-17，Task 5 六次外审）**：五次外审中“ephemeral RPC 注册失败回滚 receipt 与 Grant”的结论撤销。`2.3.0` Authority 必须把 receipt take、SignedGrant 和 finalization outbox 原子持久化，提交后才串行更新 RPC 注册；注册或 Run Store 写入失败时保留 outbox，相同稳定 finalization identity 可跨新 Host 恢复同一 Grant，不再展示 WebAuthn URL。Runtime machine 与直接 CLI 都要在用户在场前持久 reservation，恢复/最终化后在 Run lock 内重验 Run/install/type/subject/project identity；成功 outcome 改变下一次 CLI identity。新 Host 激活还必须验证完整严格 SignedGrant、当前存储态逐字段一致、签名、撤销、过期和四字段 binding。HostConfig 及所有结果/cleanup IPC 使用精确字段并有界传播稳定 cause；secret parser 临时 Buffer 全路径清零。Golden 的 RPC verify/reserve 必须由 Host1 最终化并关闭后启动的 Host2 激活持久 Grant 来提供。

> **Spec Errata（2026-07-17，Task 5 七次外审）**：commit 后 ephemeral 注册失败使用专用可恢复错误，machine/CLI 保持稳定 reservation pending；recover/注册/outcome 同处 Run lock。outcome 成功后 best-effort ack finalization outbox，ack 失败不覆盖成功；outbox 按 Grant expiry 裁剪、容量 1024、超限事务回滚、oversized snapshot 拒绝。child incoming IPC 全层 exact，错误码仅允许严格 `E2E_*`，SignedGrant/subject 的字符串、数组、数值以及 injection/WS/SSE 字段均有生产上界。parent state-key 序列化临时 Buffer 清零。parent 识别 terminal cleanup envelope、保留 Aggregate cause，并等待 exit code 区分普通退出和稳定 cleanup failure。四字段 binding 使用唯一内部 parser，但 parser 不构成 WeakMap trust 登记。真实 child 回归必须覆盖 commit-after-registration recovery 和并发 control 中“先成功、后失败、再重试”不污染先前注册。

> **Spec Errata（2026-07-17，Task 5 八次外审）**：Authority snapshot 提升到 `2.4.0`；ack 不再删除全部 finalization 证据，而是将 outbox 原子移动为包含 request digest、grantId、四字段 binding 与 expiry 的有界 tombstone。精确重复 ack 幂等，任一字段重绑定必须拒绝；outbox 与 tombstone 合计最多 1024，均按 Grant expiry 裁剪，`2.3.0` 显式迁移为空 tombstone 集。child session key 在 `registerClient` 成功或抛错后都必须 `finally` 清零。启动期 IPC disconnect 只表示传输关闭，parent 必须继续等待严格 startup-error、exit 或 timeout；非零 exit 归类稳定 cleanup failure，零 exit 归类 startup exited。Write subject 与 SignedGrant capability 必须复用唯一 `WriteHttpIntentSchema`，method 只接受 1–32 字符大写 HTTP token；Injection 保持独立 3–16 字节契约。四字段结构改名为中性的 `ApprovalExecutionBinding`/`parseApprovalExecutionBinding`，只有 WeakMap 客户端登记保留 Trusted 命名；parent 不得重复手写字段集合。machine 与直接 CLI 必须共用 `persistFinalizedApprovalOutcome`，严格执行 outcome 先持久化、成功后 best-effort ack、持久化失败保持 pending。真实边界测试必须从 `E2ERuntimeHost`/`RuntimeAuthorityHost` 穿过真实 OS child、P-256 WebAuthn、Host1 关闭与 Host2 新 session key 恢复激活，证明同一请求不触发第二次 WebAuthn，并由 Host2 RPC 完成 verify/reserve；受限 sandbox 只能明确 skip，不得冒充产品通过。

**Files:**
- Create: `packages/e2e-authority/src/webauthn-user-presence.ts`
- Create: `packages/e2e-authority/src/webauthn-approval-server.ts`
- Create: `packages/e2e-authority/test/webauthn-user-presence.test.ts`
- Create: `packages/e2e-authority/test/webauthn-approval-server.test.ts`
- Modify: `packages/e2e-authority/src/authority-execution-rpc-host-process.ts`
- Modify: `packages/e2e-authority/src/authority-execution-rpc-host.ts`
- Modify: `packages/e2e-authority/src/local-approval-authority.ts`
- Modify: `packages/e2e-authority/src/index.ts`
- Modify: `packages/e2e-authority/package.json`
- Create: `packages/e2e-runtime/assets/approval/index.html`
- Create: `packages/e2e-runtime/assets/approval/approval.js`
- Create: `packages/e2e-runtime/scripts/copy-approval-assets.mjs`
- Create: `packages/e2e-runtime/src/authority-host.ts`
- Create: `packages/e2e-runtime/test/authority-host.test.ts`
- Modify: `packages/e2e-runtime/src/runtime-host.ts`
- Modify: `packages/e2e-runtime/src/cli.ts`
- Modify: `packages/e2e-runtime/package.json`
- Modify: `package-lock.json`

**Interfaces:**
- Consumes: 现有 `LocalApprovalAuthority.open()` 的 `authenticateApproverSession` seam、Task 3 supervisor、Task 4 Run Store。
- Produces: `WebAuthnUserPresenceAuthority`、`startWebAuthnApprovalServer()`、Authority process handle 的 `enrollIdentity()` / `openApprovalSession()`。
- Produces Runtime adapter: `RuntimeAuthorityHost.enroll()`、`RuntimeAuthorityHost.requestApproval()`、`RuntimeAuthorityHost.close()`。

- [ ] **Step 1: 安装并锁定 WebAuthn 官方依赖**

Run: `npm install --workspace @mutil-skills/e2e-authority @simplewebauthn/server@13.3.2 @simplewebauthn/browser@13.3.0`

Expected: `packages/e2e-authority/package.json` 和 lockfile 固定 13.3.x 实际版本；不引用 CDN。

- [ ] **Step 2: 写 challenge 错绑、重放和无 UV 失败测试**

```ts
import { describe, expect, test } from 'vitest'
import { WebAuthnUserPresenceAuthority } from '../src/webauthn-user-presence.js'

const installationDigest = `sha256:${'a'.repeat(64)}`
const subjectDigest = `sha256:${'b'.repeat(64)}`

test('authentication session is one-time and bound to the approval subject', async () => {
  const authority = WebAuthnUserPresenceAuthority.createForTest({
    now: () => new Date('2026-07-16T00:00:00.000Z'),
    verifyAuthentication: async (input) => input.response === 'valid-assertion'
      && input.requireUserVerification
      && input.expectedOrigin === 'http://localhost:43210'
      && input.expectedRPID === 'localhost',
  })
  authority.registerTestCredential({ subject: 'local:user', credentialId: 'CRED-1', counter: 1 })
  const session = authority.beginApproval({
    runId: 'RUN-1', approvalType: 'execution', subjectDigest,
    installationDigest, origin: 'http://localhost:43210', ttlMs: 300_000,
  })

  await authority.completeApproval({
    sessionId: session.sessionId, challenge: session.challenge,
    credentialId: 'CRED-1', response: 'valid-assertion',
  })
  const binding = {
    subject: 'local:user', runId: 'RUN-1', approvalType: 'execution', subjectDigest,
    installationDigest, origin: 'http://localhost:43210',
  }
  expect(authority.authenticateSession(session.sessionId, binding)).toBe('local:user')
  expect(authority.authenticateSession(session.sessionId, binding)).toBeUndefined()
  await expect(authority.completeApproval({
    sessionId: session.sessionId, challenge: session.challenge,
    credentialId: 'CRED-1', response: 'valid-assertion',
  })).rejects.toThrow(/E2E_APPROVAL_SESSION_CONSUMED/)
})

test('rejects a response without verified user presence', async () => {
  const authority = WebAuthnUserPresenceAuthority.createForTest({
    now: () => new Date('2026-07-16T00:00:00.000Z'),
    verifyAuthentication: async () => false,
  })
  authority.registerTestCredential({ subject: 'local:user', credentialId: 'CRED-1', counter: 0 })
  const session = authority.beginApproval({
    runId: 'RUN-1', approvalType: 'scope', subjectDigest,
    installationDigest, origin: 'http://localhost:43210', ttlMs: 300_000,
  })
  await expect(authority.completeApproval({
    sessionId: session.sessionId, challenge: session.challenge,
    credentialId: 'CRED-1', response: 'no-user-verification',
  })).rejects.toThrow(/E2E_APPROVAL_USER_PRESENCE_UNAVAILABLE/)
})
```

`createForTest()` 和 `registerTestCredential()` 只从测试源路径导入，不从 package `index.ts`/`exports` 导出。

- [ ] **Step 3: 运行测试并确认 RED**

Run: `npx vitest run packages/e2e-authority/test/webauthn-user-presence.test.ts`

Expected: FAIL，模块不存在。

- [ ] **Step 4: 实现 WebAuthn identity 与 session 验证**

生产实现必须调用：

```ts
const registration = await verifyRegistrationResponse({
  response,
  expectedChallenge: pending.challenge,
  expectedOrigin: pending.origin,
  expectedRPID: 'localhost',
  requireUserVerification: true,
})

const authentication = await verifyAuthenticationResponse({
  response,
  expectedChallenge: pending.challenge,
  expectedOrigin: pending.origin,
  expectedRPID: 'localhost',
  credential: storedCredential,
  requireUserVerification: true,
})
```

credential state 包含 `id/publicKey/counter/transports/subject`，随 Authority `2.1.0` snapshot 加密持久化；真实旧版 `2.0.0` snapshot 通过事务迁移补入空 credential state，未知或非精确结构失败关闭。challenge 最长 5 分钟，单次消费，绑定 runId、approval type、subject digest、installation digest、origin；验证后使用完整 credential 作为期望值执行原子 CAS，counter 必须严格递增。注册使用原子 insert 拒绝并发重复 credential。注册选项固定 `attestationType:'none'`、`userVerification:'required'`、`supportedAlgorithmIDs:[-7,-257]`。

- [ ] **Step 5: 实现 loopback 静态审批页**

Server 只绑定 `127.0.0.1`，每次 session 生成随机 port 和 32-byte bearer。bearer 只放在 URL fragment，浏览器立即从地址栏移除；不得进入 query、Cookie、Referer 或 session payload。静态 GET 只提供当前 Runtime package 内的固定 bytes；私有 `/session` 和 `/submit` 必须使用规范 base64url `Authorization: Bearer` 且按 session 隔离。POST body 上限 64KiB，所有响应 `cache-control:no-store`、CSP `default-src 'self'`。页面从本地 `/simplewebauthn-browser.js` 加载 bundle，展示 Authority 生成的不可编辑摘要，再调用 `startRegistration()`/`startAuthentication()`。

`copy-approval-assets.mjs` 在 Runtime build 时从锁定的 `@simplewebauthn/browser@13.3.0` package realpath 复制 `dist/bundle/index.umd.min.js` 到 `assets/approval/simplewebauthn-browser.js`，复制前后校验 package version 和 bytes digest；源文件缺失、版本不符或目标发生漂移时 build 失败。Runtime server 通过 `import.meta.url` 定位该文件，不从 cwd、CDN 或项目依赖解析。

测试必须验证 remote address、错误 origin、错误 bearer、过大 body、过期 challenge 和第二次 POST 全部拒绝。

- [ ] **Step 6: 扩展 Authority 子进程控制面**

`AuthorityExecutionRpcProcessHandle` 增加：

```ts
enrollIdentity(input: { subject: string }): Promise<{ url: string; sessionId: string }>
openApprovalSession(input: {
  runId: string
  approvalType: 'scope' | 'lineage' | 'discovery' | 'execution' | 'privacy'
  subjectDigest: string
  installationDigest: string
}): Promise<{ url: string; sessionId: string }>
```

Authority child 内部把已完成 WebAuthn session 映射为绑定 subject/run/type/digests/origin/expiry 的一次性私有 receipt，并在 `authenticateApproverSession` 精确匹配后消费；Runtime parent 只能创建 session/取得 URL，不能取得 receipt 或提交“通过”结果。每个 session 只允许一个 waiter；子进程 error/exit/disconnect 必须有界拒绝全部 waiter。子进程 shutdown 时撤销所有未消费 challenge。

- [ ] **Step 7: 接入 Runtime 人类命令和 Host**

`repo-e2e identity enroll` 创建 enrollment URL；`repo-e2e approve --run-id <id> --type <scope|lineage|discovery|execution|privacy>` 使用显式 type，从 Run Store 重算 approval subject 后创建 approval URL，不允许从 workflow 猜测审批类型。两者把 URL 输出到 stderr 并等待 Authority callback；RPC `open-approval` 生产默认接线必须真实启动 Authority，其他 RPC 命令不得启动它，且不能携带 credential response 或 approved 字段。用户在场返回后重新解析并核对项目 real root、device/inode、logical project ID 和 digest，再重新取得 Run lease。

Run: `npx vitest run packages/e2e-authority/test/webauthn-user-presence.test.ts packages/e2e-authority/test/webauthn-approval-server.test.ts packages/e2e-runtime/test/authority-host.test.ts`

Expected: PASS。

Run: `npm run typecheck && npm run lint:architecture`

Expected: PASS。

- [ ] **Step 8: 提交 WebAuthn Authority**

```bash
git add packages/e2e-authority packages/e2e-runtime package-lock.json
git commit -m "feat(e2e): require user presence for runtime approvals"
```

---

### Task 6: Secret Broker 与一次性秘密注入

**Files:**
- Create: `packages/e2e-runtime/src/secret-broker.ts`
- Create: `packages/e2e-runtime/src/secret-providers.ts`
- Create: `packages/e2e-runtime/test/secret-broker.test.ts`
- Create: `packages/e2e-runtime/test/secret-providers.test.ts`
- Modify: `packages/e2e-runtime/src/environment-policy.ts`
- Modify: `packages/e2e-runtime/src/cli.ts`
- Modify: `packages/e2e-runtime/src/runtime-host.ts`

**Interfaces:**
- Consumes: Task 4 Run Store project/run binding、Task 3 minimal env。
- Produces: `RuntimeSecretBroker.provide()`、`resolve()`、`consume()`；opaque `OneTimeSecretHandle`。
- Provider IDs: `interactive`、`macos-keychain`、`linux-secret-service`；不实现 env provider。

- [ ] **Step 1: 写 env/重复消费/日志泄漏失败测试**

```ts
import { describe, expect, test } from 'vitest'
import { RuntimeSecretBroker } from '../src/secret-broker.js'

test('secret values are one-time and never serializable', async () => {
  const broker = RuntimeSecretBroker.createForTest({ encryptionKey: Buffer.alloc(32, 7) })
  await broker.provide({ runId: 'RUN-1', secretRef: 'LOGIN-PASSWORD', value: 'ssh-secret-canary' })
  const handle = await broker.resolve({ runId: 'RUN-1', secretRef: 'LOGIN-PASSWORD' })
  expect(JSON.stringify(handle)).not.toContain('ssh-secret-canary')
  expect(await broker.consume(handle)).toBe('ssh-secret-canary')
  await expect(broker.consume(handle)).rejects.toThrow(/E2E_SECRET_HANDLE_CONSUMED/)
})

test('does not resolve process environment variables', async () => {
  const broker = RuntimeSecretBroker.createForTest({ encryptionKey: Buffer.alloc(32, 8) })
  process.env.LOGIN_PASSWORD = 'host-env-canary'
  await expect(broker.resolve({ runId: 'RUN-1', secretRef: 'LOGIN-PASSWORD' }))
    .rejects.toThrow(/E2E_SECRET_NOT_PROVIDED/)
  delete process.env.LOGIN_PASSWORD
})
```

- [ ] **Step 2: 运行测试并确认 RED**

Run: `npx vitest run packages/e2e-runtime/test/secret-broker.test.ts`

Expected: FAIL，模块不存在。

- [ ] **Step 3: 实现加密存储和 opaque handle**

每 Run 生成 32-byte data key；secret value 使用 AES-256-GCM，AAD 固定绑定 `{ runId, secretRef, providerId }`。master key 位于 Authority 用户级 root、0600，项目 root 被禁止。opaque handle 只含随机 ID，并在模块内 WeakMap/Map 绑定 runId/ref；消费后立即清零 plaintext Buffer 和删除 handle。

```ts
export interface SecretProvider {
  readonly id: 'interactive' | 'macos-keychain' | 'linux-secret-service'
  resolve(secretRef: string): Promise<Uint8Array | undefined>
}

export interface OneTimeSecretHandle {
  readonly handleId: string
  readonly runId: string
  readonly secretRef: string
}
```

接口不从 `packages/e2e-runtime/src/index.ts` 导出；Browser Host 通过构造依赖获得 broker。

- [ ] **Step 4: 实现平台 provider 与隐藏输入**

macOS 使用绝对 `/usr/bin/security find-generic-password -w -s <service> -a <account>`；Linux 使用经过 realpath 验证的 `/usr/bin/secret-tool lookup service <service> account <account>`。都使用 `spawn` 参数数组、禁止 shell、stdout 上限 64KiB、stderr 脱敏。`repo-e2e secret provide` 要求 `stdin.isTTY`，关闭 echo 后读取一次，写入 broker 后清空 buffer；非 TTY 返回 `E2E_SECRET_INTERACTIVE_TTY_REQUIRED`。

- [ ] **Step 5: 运行 GREEN 验证**

Run: `npx vitest run packages/e2e-runtime/test/secret-broker.test.ts packages/e2e-runtime/test/secret-providers.test.ts packages/e2e-runtime/test/environment-policy.test.ts`

Expected: PASS，输出与错误中均无 canary。

Run: `npm run typecheck && npm run lint:architecture`

Expected: PASS。

- [ ] **Step 6: 提交 Secret Broker**

```bash
git add packages/e2e-runtime
git commit -m "feat(e2e): isolate runtime secrets from test processes"
```

---

### Task 7: 独立 Gateway Proxy Host（HTTP/HTTPS/WebSocket）

**Files:**
- Create: `packages/e2e-runtime/src/gateway-proxy-host-process.ts`
- Create: `packages/e2e-runtime/src/gateway-proxy-host.ts`
- Create: `packages/e2e-runtime/src/gateway-rule-projector.ts`
- Create: `packages/e2e-runtime/test/gateway-proxy-host.test.ts`
- Create: `packages/e2e-runtime/test/gateway-proxy-security.test.ts`
- Modify: `packages/e2e-gateway/src/index.ts`
- Modify: `packages/e2e-runtime/package.json`
- Modify: `package-lock.json`

**Interfaces:**
- Consumes: `ReadOnlyGateway`、`ReversibleWriteGateway`、`InjectionGateway`、`ProtocolGuard`、`LocalGatewayAuditSigner`、Authority execution RPC clients。
- Produces: `startGatewayProxyHost()`、`GatewayProxyProcessHandle`、`GatewaySessionMeasurement`。
- Produces test helper: `startGatewayProxyHostForTest(): Promise<GatewayProxyTestHandle>`；该类型仅存在于 `test/fixtures.ts`，不从 Runtime package 导出。
- Third-party adapter: Mockttp only handles transport/TLS; all allow/inject/write decisions come from existing E2E policy objects.

- [ ] **Step 1: 安装并锁定 Mockttp**

Run: `npm install --workspace @mutil-skills/e2e-runtime mockttp@4.4.2`

Expected: Runtime package/lockfile 登记 4.4.2；license 为 Apache-2.0。

- [ ] **Step 2: 写真实代理 allow/deny/inject 失败测试**

```ts
import { createServer } from 'node:http'
import { afterEach, expect, test } from 'vitest'
import { startGatewayProxyHostForTest } from './fixtures.js'

const handles: Array<{ close(): Promise<void> }> = []
afterEach(async () => { await Promise.all(handles.splice(0).map((handle) => handle.close())) })

test('forwards only an approved correlated request and denies unmatched traffic', async () => {
  const upstream = createServer((request, response) => {
    response.end(request.url === '/allowed' ? 'allowed' : 'unexpected')
  })
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve))
  handles.push({ close: () => new Promise((resolve, reject) => upstream.close((error) => error ? reject(error) : resolve())) })
  const address = upstream.address()
  if (!address || typeof address === 'string') throw new Error('fixture address missing')
  const target = `http://127.0.0.1:${address.port}/allowed`

  const gateway = await startGatewayProxyHostForTest({
    runId: 'RUN-1',
    mode: 'real-environment',
    approvedRequests: [{ actionId: 'ACTION-1', capabilityId: 'CAP-1', method: 'GET', url: target, maxUses: 1 }],
  })
  handles.push(gateway)

  expect(await gateway.requestThroughProxy(target, { actionId: 'ACTION-1', capabilityId: 'CAP-1' }))
    .toMatchObject({ status: 200, body: 'allowed' })
  expect(await gateway.requestThroughProxy(`http://127.0.0.1:${address.port}/denied`,
    { actionId: 'ACTION-1', capabilityId: 'CAP-1' })).toMatchObject({ status: 403 })
  expect((await gateway.finalize()).counters).toMatchObject({ forwarded: 1, blocked: 1, injected: 0 })
})
```

- [ ] **Step 3: 运行测试并确认 RED**

Run: `npx vitest run packages/e2e-runtime/test/gateway-proxy-host.test.ts`

Expected: FAIL，Gateway Host 模块不存在。

- [ ] **Step 4: 实现 CA、规则投影和 fallback deny**

Gateway child 启动时使用：

```ts
const ca = await generateCACertificate({
  subject: { commonName: 'mutil-skills local E2E CA', organizationName: 'mutil-skills' },
})
const proxy = getLocal({ https: { key: ca.key, cert: ca.cert } })
await proxy.start()
```

CA key/cert 写入 Authority root，mode 0600/0600；不修改系统 trust store。每个 approved request rule 必须匹配 method、完整 URL、随机 `x-mutil-e2e-action-token` 和必要 body；real 模式用 `thenPassThrough()`，注入模式用固定 `thenReply/thenTimeout/thenResetConnection`。最后注册 `forUnmatchedRequest().thenReply(403, 'E2E_GATEWAY_DEFAULT_DENY')` 与未批准 WebSocket close rule。

Action token 由 Host 随机生成并通过 Browser route 注入，网页/Skill 不获得 token。每个 rule 用 `.times(maxUses)`；规则匹配前后调用现有 Authority/Gateway policy 与 audit recorder。写转发前必须 reserve，成功 complete，连接结果未知时 markUnknown。

- [ ] **Step 5: 实现独立子进程与认证父句柄**

```ts
export interface GatewayProxyProcessHandle {
  pid: number
  endpoint: string
  caCertPath: string
  caSpkiFingerprint: string
  measurement: GatewaySessionMeasurement
  auditSummary(): GatewayAuditSummary
  finalize(): Promise<GatewayPublicationAudit>
  close(): Promise<void>
}

export interface GatewayProxyTestHandle extends GatewayProxyProcessHandle {
  requestThroughProxy(
    url: string,
    correlation: { actionId: string; capabilityId: string },
  ): Promise<{ status: number; body: string }>
}

export interface GatewaySessionMeasurement {
  runId: string
  policyDigest: string
  proxyEndpointDigest: string
  processEntrypointDigest: string
}
```

parent/child IPC 消息必须带 session MAC、sequence 和 requestId；endpoint 必须 loopback。child disconnect 时停止 Mockttp、清除 action tokens、把未完成 reservation 标 unknown。
`GatewayProxyTestHandle.requestThroughProxy()` 由 `test/fixtures.ts` 使用窄化的测试注入端口实现，只用于验证真实代理传输；生产 `GatewayProxyProcessHandle` 不暴露 action token 或任意代理请求方法。

- [ ] **Step 6: 增加 HTTPS/WebSocket/Beacon/Service Worker 安全矩阵**

测试创建本地 HTTPS 和 WebSocket fixture：正确 CA/SPKI 和 token 可通过；错误 token、第二次 maxUses、未知 host、WebSocket 未授权、QUIC/UDP/unknown protocol 均 blocked。Service Worker 在 Browser Task 中被禁用；Gateway 测试仍需确认其直接 HTTP 请求没有 token 时被拒绝。

Run: `npx vitest run packages/e2e-runtime/test/gateway-proxy-host.test.ts packages/e2e-runtime/test/gateway-proxy-security.test.ts`

Expected: PASS。

Run: `npm run typecheck && npm run lint:architecture`

Expected: PASS。

- [ ] **Step 7: 提交 Gateway Host**

```bash
git add packages/e2e-gateway packages/e2e-runtime package-lock.json
git commit -m "feat(e2e): enforce browser traffic through local gateway"
```

---

### Task 8: Chromium 安装、Browser Host 与最小只读纵向闭环

**Files:**
- Create: `packages/e2e-runtime/src/browser-installer.ts`
- Create: `packages/e2e-runtime/src/browser-host.ts`
- Create: `packages/e2e-runtime/src/trusted-action-runner.ts`
- Create: `packages/e2e-runtime/test/browser-installer.test.ts`
- Create: `packages/e2e-runtime/test/browser-host.test.ts`
- Create: `packages/e2e-runtime/test/read-only-runtime-flow.test.ts`
- Modify: `packages/e2e-runtime/src/runtime-doctor.ts`
- Modify: `packages/e2e-runtime/src/runtime-host.ts`
- Modify: `packages/e2e-runtime/src/cli.ts`
- Modify: `packages/e2e-playwright-runtime/src/playwright-page-adapter.ts`

**Interfaces:**
- Consumes: Task 5 Authority grants、Task 7 Gateway handle、`runBrowserPreflight()`、`runReadOnlyCase()`、`PlaywrightPageAdapter`。
- Produces: `installChromium()`、`ControlledBrowserHost.open()`、`TrustedActionRunner.executeReadOnly()`。
- Authoritative execution input contains only validated Action Map and signed grants; no source path/source bytes.

- [ ] **Step 1: 写显式安装与固定参数失败测试**

```ts
import { expect, test } from 'vitest'
import { chromiumLaunchOptions } from '../src/browser-host.js'

test('browser options force the runtime gateway and reject caller args', () => {
  const options = chromiumLaunchOptions({
    executablePath: '/runtime/browsers/chromium',
    proxyEndpoint: 'http://127.0.0.1:43111',
    caSpkiFingerprint: 'SPKI-FINGERPRINT',
    profileDir: '/runtime/state/RUN-1/browser-profile',
  })
  expect(options).toMatchObject({
    executablePath: '/runtime/browsers/chromium',
    proxy: { server: 'http://127.0.0.1:43111' },
  })
  expect(options.args).toEqual(expect.arrayContaining([
    '--disable-quic', '--disable-extensions', '--disable-background-networking',
    '--ignore-certificate-errors-spki-list=SPKI-FINGERPRINT',
  ]))
  expect(JSON.stringify(options)).not.toContain('callerArgs')
})
```

- [ ] **Step 2: 运行测试并确认 RED**

Run: `npx vitest run packages/e2e-runtime/test/browser-installer.test.ts packages/e2e-runtime/test/browser-host.test.ts`

Expected: FAIL，Browser Host 模块不存在。

- [ ] **Step 3: 实现显式 Chromium 安装**

`installChromium()` 使用当前 Runtime version 内 `playwright/cli.js` 的绝对 realpath，通过 `process.execPath` 启动 `install chromium`，并设置 `PLAYWRIGHT_BROWSERS_PATH=<versioned browser root>`。只有 `repo-e2e install-browser` 调用；`doctor` 不调用。安装后记录 executable realpath、byteLength、digest、Playwright version、platform 到 browser manifest，mode 0700/0600。

- [ ] **Step 4: 实现固定 Browser Host**

```ts
export interface ControlledBrowserSession {
  browser: Browser
  context: BrowserContext
  page: Page
  measurement: {
    browserExecutableDigest: string
    gatewayProxyEndpointDigest: string
    sandboxProfileDigest: string
  }
  close(): Promise<void>
}
```

context 固定 `serviceWorkers:'block'`、批准的 locale/timezone/viewport、空白 user-data-dir；禁止 extension、download、file URL、caller args 和 persistent user profile。启动后先执行两项 canary：批准 canary 到达本次 Gateway；未批准 canary 被本次 Gateway 计为 blocked。measurement 必须绑定 Gateway process measurement。

- [ ] **Step 5: 实现不加载生成源码的只读 Runner**

```ts
export interface DeclarativeReadAction {
  caseId: string
  actionId: string
  url: string
  expectedIdentity: { url: string; title: string; heading: string; role: string }
  expectedText: string
}

export class TrustedActionRunner {
  async executeReadOnly(input: {
    action: DeclarativeReadAction
    grant: SignedReadGrant
    currentSubject: ReadApprovalSubject
    authority: ReadAuthorityClient
    browser: ControlledBrowserSession
    gateway: GatewayProxyProcessHandle
    attemptId: string
  }): Promise<{
    result: ReadOnlyCaseResult
    evidence?: { screenshot: Uint8Array; dom: Uint8Array }
  }> {
    const capture = new CapturingPageAdapter(new PlaywrightPageAdapter(input.browser.page))
    const result = await runReadOnlyCase({
      ...input.action,
      authorization: { grant: input.grant, currentSubject: input.currentSubject, authority: input.authority },
      attemptId: input.attemptId,
      runtime: { sandboxHealthy: true, gatewayConnected: true },
      gatewayAudit: () => input.gateway.auditSummary(),
      page: capture,
    })
    const evidence = capture.evidence()
    return { result, ...(evidence === undefined ? {} : { evidence }) }
  }
}

class CapturingPageAdapter implements BrowserPageAdapter {
  #screenshot?: Uint8Array
  #dom?: string

  constructor(private readonly delegate: BrowserPageAdapter) {}

  goto(url: string) { return this.delegate.goto(url) }
  identity() { return this.delegate.identity() }
  containsText(text: string) { return this.delegate.containsText(text) }

  async screenshot(): Promise<Uint8Array> {
    const bytes = await this.delegate.screenshot()
    this.#screenshot = bytes.slice()
    return bytes
  }

  async domSnapshot(): Promise<string> {
    const dom = await this.delegate.domSnapshot()
    this.#dom = dom
    return dom
  }

  evidence(): { screenshot: Uint8Array; dom: Uint8Array } | undefined {
    if (this.#screenshot === undefined || this.#dom === undefined) return undefined
    return { screenshot: this.#screenshot.slice(), dom: Buffer.from(this.#dom, 'utf8') }
  }
}
```

`CapturingPageAdapter` 只能返回本次 `runReadOnlyCase()` 捕获的 bytes；不允许事后重跑 screenshot/DOM。Runtime Host 不调用 Compiler 或 `playwright test` 执行权威 Case。

- [ ] **Step 6: 完成一个只读 PRD tracer bullet**

集成测试启动本地 fixture 页面“待审核订单”，用真实 Authority test adapter 签发 discovery/read grant、真实 Gateway process 和真实 Chromium，依次执行 preflight 与单个 declarative action。断言：

```ts
expect(flow.status).toBe('passed')
expect(flow.result.caseId).toBe('CASE-ORDER-LIST')
expect(flow.gatewayAudit.counters.forwarded).toBeGreaterThan(0)
expect(flow.gatewayAudit.counters.blocked).toBeGreaterThan(0)
expect(flow.evidence?.screenshot.byteLength).toBeGreaterThan(0)
expect(Buffer.from(flow.evidence?.dom ?? []).toString('utf8')).toContain('待审核订单')
expect(flow.loadedGeneratedSourceFiles).toEqual([])
```

如果本机 Chromium 未安装，单元/普通集成测试使用显式 test adapter；真实浏览器用现有 Golden 配置运行，不把 skip 计为功能通过。

- [ ] **Step 7: 更新 Doctor 并运行 GREEN 验证**

Doctor 的 chromium/gateway/isolation probes 改为真实 proof；browser 未安装返回精确 `repo-e2e install-browser` remediation。

Run: `npx vitest run packages/e2e-runtime/test/browser-installer.test.ts packages/e2e-runtime/test/browser-host.test.ts packages/e2e-runtime/test/read-only-runtime-flow.test.ts`

Expected: PASS（非浏览器测试）。

Run: `npx vitest run --config vitest.e2e.config.ts scripts/e2e-read-only.golden.test.ts`

Expected: 真实 Chromium Golden PASS。

Run: `npm run typecheck && npm run lint:architecture`

Expected: PASS。

- [ ] **Step 8: 提交只读 Runtime 纵向闭环**

```bash
git add packages/e2e-runtime packages/e2e-playwright-runtime
git commit -m "feat(e2e): run declarative read cases in isolated chromium"
```

---

### Task 9: 可逆写、故障注入、Secret 与 Cleanup 纵向闭环

**Files:**
- Create: `packages/e2e-runtime/test/write-runtime-flow.test.ts`
- Create: `packages/e2e-runtime/test/injection-runtime-flow.test.ts`
- Create: `packages/e2e-runtime/test/effect-unknown-recovery.test.ts`
- Create: `packages/e2e-runtime/test/runtime-recovery.test.ts`
- Modify: `packages/e2e-runtime/test/fixtures.ts`
- Modify: `packages/e2e-runtime/src/trusted-action-runner.ts`
- Modify: `packages/e2e-runtime/src/runtime-host.ts`
- Create: `packages/e2e-runtime/src/runtime-recovery.ts`
- Modify: `packages/e2e-runtime/src/gateway-rule-projector.ts`
- Modify: `packages/e2e-runtime/src/secret-broker.ts`
- Modify: `packages/e2e-playwright-runtime/src/write-runner.ts`
- Modify: `packages/e2e-playwright-runtime/src/controlled-write-bridge.ts`

**Interfaces:**
- Consumes: `runReversibleWriteCase()`、`LocalCleanupPlanRegistry`、Authority/Lease RPC、Task 6 secret handle、Task 7 Gateway、Task 8 Browser session。
- Produces: `TrustedActionRunner.executeWrite()`、`executeInjection()`、`RuntimeRecoveryCoordinator.recover()`、`RuntimeExecutionBatch`。
- Produces test helpers: `executeWriteFixtureFlow(input: { effectObservation: 'applied' | 'unknown'; cleanupStatus: 'verified-clean' | 'unknown' }): Promise<WriteFixtureFlowResult>`、`executeInjectionFixtureFlow(input: { injectedStatus: number }): Promise<InjectionFixtureFlowResult>`。
- Execution batch freezes real and injection results separately; injection can never replace real result.

- [ ] **Step 1: 写写入 reservation/outcome/cleanup 失败测试**

```ts
import { expect, test } from 'vitest'
import { executeWriteFixtureFlow } from './fixtures.js'

test('a write is accepted only after signed outcome and verified cleanup', async () => {
  const flow = await executeWriteFixtureFlow({ effectObservation: 'applied', cleanupStatus: 'verified-clean' })
  expect(flow.result.status).toBe('passed')
  expect(flow.result.outcomeDigest).toMatch(/^sha256:/)
  expect(flow.gatewayAudit.capabilityReservations).toEqual([
    expect.objectContaining({ actionId: 'ACTION-ORDER-UPDATE', status: 'completed' }),
  ])
  expect(flow.cleanup).toMatchObject({ status: 'verified-clean' })
})

test('effect unknown is never retried or resumed automatically', async () => {
  const flow = await executeWriteFixtureFlow({ effectObservation: 'unknown', cleanupStatus: 'unknown' })
  expect(flow.result.status).toBe('safety-blocked')
  expect(flow.retryDecision).toMatchObject({ allowed: false })
  expect(flow.resumeAutomatically).toBe(false)
  expect(flow.lease.status).toBe('quarantined')
})
```

`WriteFixtureFlowResult` 必须精确包含测试读取的 `result`、`gatewayAudit`、`cleanup`、`retryDecision`、`resumeAutomatically`、`lease` 字段。`executeWriteFixtureFlow()` 在 `packages/e2e-runtime/test/fixtures.ts` 中使用真实 Local Authority/Lease/Gateway policy 和内存页面 adapter，不绕过任何签名/摘要检查。

- [ ] **Step 2: 写注入零上游副作用失败测试**

```ts
import { expect, test } from 'vitest'
import { executeInjectionFixtureFlow } from './fixtures.js'

test('injection replies at the gateway and never reaches the upstream write endpoint', async () => {
  const flow = await executeInjectionFixtureFlow({ injectedStatus: 503 })
  expect(flow.result.mode).toBe('gateway-injection')
  expect(flow.gatewayAudit.counters).toMatchObject({ injected: 1 })
  expect(flow.upstreamWriteCount).toBe(0)
  expect(flow.realEnvironmentResult).toBeDefined()
})
```

`InjectionFixtureFlowResult` 必须精确包含测试读取的 `result`、`gatewayAudit`、`upstreamWriteCount`、`realEnvironmentResult` 字段；fixture 通过本地 upstream 计数器证明注入没有上游副作用。

- [ ] **Step 3: 运行测试并确认 RED**

Run: `npx vitest run packages/e2e-runtime/test/write-runtime-flow.test.ts packages/e2e-runtime/test/injection-runtime-flow.test.ts packages/e2e-runtime/test/effect-unknown-recovery.test.ts`

Expected: FAIL，write/injection Runtime 方法不存在。

- [ ] **Step 4: 实现声明式写 Action 与 secret 注入**

```ts
export interface DeclarativeWriteAction {
  caseId: string
  stepId: string
  actionId: string
  operation: 'fill-and-submit' | 'click-submit' | 'http-request'
  target: string
  value?: { kind: 'literal'; value: string } | { kind: 'secret-ref'; secretRef: string }
  expectedText: string
  cleanupPlanId: string
  dataLeaseId: string
  fencingToken: number
}
```

Runner 对 `secret-ref` 只在 Bridge 即将执行 `page.fill()` 时消费 handle；不得把值复制到 Action、Playwright trace、console 或 Gateway audit。写入顺序固定为 freshness→grant verify→lease verify→Gateway reserve→browser action→同次 outcome receipt→Authority complete/unknown→verification→cleanup→lease release/quarantine。

- [ ] **Step 5: 实现 real/injection 分域**

`executeInjection()` 必须创建新的 Gateway session，只加载已签名 injection rule，不带 real write pass-through rule。Runtime Host 要求同一 Case 已有真实模式结果，分别保存 `mode:'real-environment'` 和 `mode:'gateway-injection'`；注入结果不得计入真实通过率。

WebSocket/SSE/Beacon action 继续走 `ProtocolGuard`；Service Worker 保持 block。任一 redirect 的新 origin 必须重新命中已批准规则，否则 fallback deny。

- [ ] **Step 6: 实现崩溃恢复语义**

Host 开始写 action 前把 reservation/action/attempt 记入 Run Store；完成后写 outcome digest。`RuntimeRecoveryCoordinator.recover()` 固定按以下顺序执行，并把每步摘要追加到 Task 4 hash-chained journal：

1. 重验 Runtime installation、state owner/mode 和 Run journal；
2. 清理只属于当前 owner marker 的失效 loopback endpoint、browser profile lock 和安装 staging；
3. 读取 Authority reservation，把缺 outcome 的写请求 `markUnknown()`，隔离 lease；
4. 调用现有 Artifact Store recovery，并重验 active/staged generation；
5. 重验 frozen artifact digest、Engine `resumeState` 和可达 resume edge；
6. 返回安全的下一动作，不调用 Browser action、不重签审批、不自动重试。

任一步证明失败都把 Run 置 `safety-blocked` 或 `migration-required`。`runtime-recovery.test.ts` 使用记录调用顺序的窄适配器，断言 effect unknown 只调用 `markUnknown/quarantine`，Browser adapter 调用次数为 0，错误 owner 的 endpoint/staging 保持原样且返回 blocked。

- [ ] **Step 7: 运行 GREEN 验证**

Run: `npx vitest run packages/e2e-runtime/test/write-runtime-flow.test.ts packages/e2e-runtime/test/injection-runtime-flow.test.ts packages/e2e-runtime/test/effect-unknown-recovery.test.ts packages/e2e-runtime/test/runtime-recovery.test.ts`

Expected: PASS。

Run: `npx vitest run --config vitest.e2e.config.ts scripts/e2e-write.golden.test.ts scripts/e2e-injection-healing.golden.test.ts`

Expected: 相关真实 Golden PASS。

Run: `npm run typecheck && npm run lint:architecture`

Expected: PASS。

- [ ] **Step 8: 提交写入与注入闭环**

```bash
git add packages/e2e-runtime packages/e2e-playwright-runtime
git commit -m "feat(e2e): execute gated writes and gateway injections"
```

---

### Task 10: Git 外 Quarantine、回归编译、同代发布与 Runtime Provenance 报告

**Files:**
- Create: `packages/e2e-runtime/src/quarantine-secret-provider.ts`
- Create: `packages/e2e-runtime/src/regression-publisher.ts`
- Create: `packages/e2e-runtime/src/generation-assembler.ts`
- Create: `packages/e2e-runtime/src/project-publisher.ts`
- Create: `packages/e2e-runtime/test/quarantine-publication.test.ts`
- Create: `packages/e2e-runtime/test/regression-publisher.test.ts`
- Create: `packages/e2e-runtime/test/generation-assembler.test.ts`
- Create: `packages/e2e-runtime/test/project-publisher.test.ts`
- Modify: `packages/e2e-runtime/test/fixtures.ts`
- Modify: `packages/e2e-contracts/src/artifacts.ts`
- Modify: `packages/e2e-contracts/test/artifact-registry.test.ts`
- Modify: `packages/e2e-engine/src/complete-generation-builder.ts`
- Modify: `packages/e2e-engine/src/generation-audit.ts`
- Modify: `packages/e2e-engine/test/complete-generation.fixture.ts`
- Modify: `packages/e2e-report/src/complete-report.ts`
- Modify: `packages/e2e-report/test/complete-report.test.ts`
- Modify: `packages/e2e-runtime/src/runtime-host.ts`

**Interfaces:**
- Consumes: `EncryptedQuarantine`、分类型 sanitizer、`PatternPrivacyScanner`、`projectCompilerInputFromArtifacts()`、固定 Compiler、`buildCompleteGeneration()`、`LocalArtifactStore`、`renderCompleteReport()`。
- Produces: `RuntimeProvenance` artifact fields、`RegressionPublisher.compile()`、`GenerationAssembler.finalize()`、`ProjectPublisher.publish()`。
- Produces test helper: `finalizeRuntimeGenerationFixture(input: { screenshotTextCanary: boolean }): Promise<RuntimeGenerationFixtureResult>`；结果精确包含测试读取的 `files` 与 `finalReport`。
- Quarantine provider persists encrypted key material only under user Authority root; project root is forbidden.

- [ ] **Step 1: 写 raw evidence 和 provenance 失败测试**

```ts
import { expect, test } from 'vitest'
import { finalizeRuntimeGenerationFixture } from './fixtures.js'

test('publishes only sanitized evidence and binds runtime provenance', async () => {
  const generation = await finalizeRuntimeGenerationFixture({ screenshotTextCanary: false })
  expect(generation.files.some((file) => file.path.includes('quarantine'))).toBe(false)
  expect(generation.finalReport.content.runtimeProvenance).toMatchObject({
    runtimeVersion: '0.0.0',
    protocolVersion: '1.0.0',
    sourceRepositoryIndependent: true,
  })
  expect(generation.finalReport.content.runtimeProvenance.runtimeInstallationDigest).toMatch(/^sha256:/)
})

test('blocks publication when a privacy canary survives sanitization', async () => {
  await expect(finalizeRuntimeGenerationFixture({ screenshotTextCanary: true }))
    .rejects.toThrow(/E2E_PRIVACY_CANARY_DETECTED/)
})
```

- [ ] **Step 2: 运行测试并确认 RED**

Run: `npx vitest run packages/e2e-runtime/test/quarantine-publication.test.ts packages/e2e-runtime/test/generation-assembler.test.ts`

Expected: FAIL，generation Runtime adapter 不存在或 Schema 缺 runtime provenance。

- [ ] **Step 3: 扩展 Artifact/Report Runtime Provenance Schema**

新增严格结构并同时登记于 `generation-manifest.content.runtimeProvenance` 与 `final-report.content.runtimeProvenance`：

```ts
export const RuntimeProvenanceSchema = z.object({
  runtimeVersion: z.string().regex(/^\d+\.\d+\.\d+$/),
  runtimeInstallationDigest: DigestSchema,
  protocolVersion: z.literal('1.0.0'),
  contractsVersion: z.string().regex(/^\d+\.\d+\.\d+$/),
  engineVersion: z.string().regex(/^\d+\.\d+\.\d+$/),
  playwrightVersion: z.string().regex(/^\d+\.\d+\.\d+$/),
  chromiumDigest: DigestSchema,
  gatewayPolicyDigest: DigestSchema,
  authorityPublicKeyDigest: DigestSchema,
  projectIdentityDigest: DigestSchema,
  sourceRevisionDigest: DigestSchema,
  sourceRepositoryIndependent: z.literal(true),
  isolationProofDigest: DigestSchema,
}).strict()
```

Engine audit 必须要求 manifest/report 两份 provenance canonical 相等，并与实际 Host measurement/approval/gateway/browser facts一致。报告渲染新增“Runtime 与隔离证明”章节，不输出绝对路径。

- [ ] **Step 4: 实现持久 Quarantine key provider**

`RuntimeQuarantineSecretProvider` 把每 Run data key 用 Authority master key AES-256-GCM 包装，文件位于 `~/.mutil-skills/e2e/quarantine/<runId>/key-envelope.json`，mode 0600。它实现现有 `QuarantineSecretProvider`；root realpath 必须在 Git 工作区外，项目 `.biztest/quarantine` 一旦存在普通文件即发布阻塞。

raw screenshot/DOM/network/trace 先写 `EncryptedQuarantine`，再由对应 sanitizer 读取。sanitized output、attestation、privacy review 全部通过后，assembler 才把 bytes 加入 generation supporting files；发布成功后按 retention policy crypto-erasure。

- [ ] **Step 5: 实现“执行后编译”的 Regression Publisher**

```ts
export interface RegressionPublicationResult {
  compilerInputDigest: string
  sourceSetDigest: string
  discoveryAttestation: RegressionDiscoveryAttestation
  caseIds: string[]
  files: Array<{ relativePath: string; bytes: Uint8Array }>
}
```

输入只来自本代已批准 Artifact projection；Compiler 在空 staging 生成 source。`playwright test --list` 通过 Task 3 supervisor 在 macOS `/usr/bin/sandbox-exec` 或 Linux `/usr/bin/bwrap` 低权限 profile 中运行：无 target network、空 env、临时 HOME、Runtime read-only、staging read-only。list 只校验 Case 集合；不生成 BrowserResult/Evidence/Verdict。项目内已有测试和修改后的 source 不参与。

- [ ] **Step 6: 实现通用 Generation Assembler**

Assembler 输入由 Host 收集的已解析 semantic drafts、Authority receipts、真实/注入 results、signed Gateway audit、sanitized evidence、cleanup、regression publication 和 Runtime provenance 组成。它调用 `buildCompleteGeneration()`，不得复制 verdict 逻辑：

```ts
export interface FinalizeRuntimeGenerationInput {
  context: CompleteGenerationContext
  semanticDrafts: Record<string, CompleteArtifactDraft>
  execution: RuntimeExecutionBatch
  gatewayAudit: GatewayPublicationAudit
  evidence: SanitizedRuntimeEvidence[]
  cleanup: CleanupResult[]
  regression: RegressionPublicationResult
  provenance: RuntimeProvenance
  authorities: CompleteGenerationAuthority
}
```

所有 27 类 artifact 和 supporting file 由 builder/Schema 重验；缺任一输入返回相应 blocked，不以空数组伪装完成。

- [ ] **Step 7: 实现项目发布与报告命令**

`ProjectPublisher` 将 `LocalArtifactStore` root 固定为 `<project>/.biztest`，调用 `publishPrepared()`，staged audit 使用 `createCompletePublicationAuditor()`；commit 后再次 readActive 并核对 generation digest。`repo-e2e report --run-id` 只读取 active generation 的 final-report，再调用 renderer；不读未提交 staging。

- [ ] **Step 8: 运行 GREEN 验证**

Run: `npx vitest run packages/e2e-runtime/test/quarantine-publication.test.ts packages/e2e-runtime/test/regression-publisher.test.ts packages/e2e-runtime/test/generation-assembler.test.ts packages/e2e-runtime/test/project-publisher.test.ts packages/e2e-report/test/complete-report.test.ts`

Expected: PASS。

Run: `npm run typecheck && npm run lint:architecture`

Expected: PASS。

Run: `npm run e2e:golden`

Expected: 既有全部 Golden PASS，且 authoritative flow 不执行 generated source。

- [ ] **Step 9: 提交发布与报告闭环**

```bash
git add packages/e2e-contracts packages/e2e-engine packages/e2e-report packages/e2e-runtime
git commit -m "feat(e2e): publish runtime-provenanced generations"
```

---

### Task 11: Skill Manifest 单一能力门与中文 Runtime 调用协议

**Files:**
- Modify: `packages/schema/src/index.ts`
- Modify: `packages/schema/schemas/skill.manifest.schema.json`
- Modify: `packages/schema/test/skill-manifest.test.ts`
- Modify: `packages/skills/skills/testing/e2e/skill.manifest.json`
- Modify: `packages/skills/skills/testing/e2e/SKILL.md`
- Modify: `packages/skills/skills/testing/e2e/prd-intake.md`
- Modify: `packages/skills/skills/testing/e2e/scope-approval.md`
- Modify: `packages/skills/skills/testing/e2e/execution-approval.md`
- Modify: `packages/skills/skills/testing/e2e/browser-preflight-binding.md`
- Modify: `packages/skills/skills/testing/e2e/safety-gateway.md`
- Modify: `packages/skills/skills/testing/e2e/browser-execution.md`
- Modify: `packages/skills/skills/testing/e2e/evidence-privacy.md`
- Modify: `packages/skills/skills/testing/e2e/regression-publication.md`
- Modify: `packages/skills/skills/testing/e2e/report-verdict.md`
- Modify: `packages/skills/skills/testing/e2e/artifact-transaction.md`
- Modify: `packages/skills/test/e2e-skill.test.ts`

**Interfaces:**
- Consumes: Runtime protocol `1.0.0`、稳定 launcher、Doctor、Host state/result。
- Produces: manifest capability `e2e.runtime-host`；缺失动作 `prompt-install`；中文 Skill 只调用 JSON stdin/stdout。
- Skill 不再直接探测/建议安装七个低层 package。

- [ ] **Step 1: 写 Manifest 和中文调用契约失败测试**

```ts
test('E2E skill requires one installable runtime host', async () => {
  const manifestText = await readFile(new URL('../skills/testing/e2e/skill.manifest.json', import.meta.url), 'utf8')
  const manifest = parseSkillManifest(JSON.parse(manifestText))
  expect(manifest.requires).toEqual([{
    capability: 'e2e.runtime-host',
    satisfiedBy: [
      '~/.mutil-skills/bin/repo-e2e doctor --json',
      'verified installation manifest + protocol major + safety probes',
    ],
    whenMissing: {
      action: 'prompt-install',
      package: '@mutil-skills/e2e-runtime',
      version: '0.1.0',
      terminalState: 'environment-blocked',
      reasonCode: 'E2E_RUNTIME_HOST_UNAVAILABLE',
    },
  }])
})

test('Skill uses the stable JSON protocol and never imports low-level runtime packages', async () => {
  const text = await readFile(new URL('../skills/testing/e2e/SKILL.md', import.meta.url), 'utf8')
  expect(text).toContain('~/.mutil-skills/bin/repo-e2e rpc')
  expect(text).toContain('doctor --json')
  expect(text).toContain('docs-only')
  expect(text).toContain('不得把 `approved: true` 当作审批')
  expect(text).not.toMatch(/import .*@mutil-skills\/e2e-/)
})
```

- [ ] **Step 2: 运行测试并确认 RED**

Run: `npx vitest run packages/schema/test/skill-manifest.test.ts packages/skills/test/e2e-skill.test.ts`

Expected: FAIL，旧 manifest 仍含七个 capability。

- [ ] **Step 3: 扩展 Manifest Schema**

```ts
export const E2ERuntimeHostRequirementSchema = z.object({
  capability: z.literal('e2e.runtime-host'),
  satisfiedBy: z.array(z.string().min(1)).min(1),
  whenMissing: z.object({
    action: z.literal('prompt-install'),
    package: z.literal('@mutil-skills/e2e-runtime'),
    version: z.string().regex(/^\d+\.\d+\.\d+$/),
    terminalState: z.literal('environment-blocked'),
    reasonCode: z.literal('E2E_RUNTIME_HOST_UNAVAILABLE'),
  }).strict(),
}).strict()
```

同时更新手写 JSON Schema；保留旧 capability parser 只用于历史 manifest 迁移测试，不允许新 E2E manifest 使用。

- [ ] **Step 4: 改写 Skill 入口和子 Skill**

入口顺序固定为：

```text
读取 manifest
→ 调用 ~/.mutil-skills/bin/repo-e2e doctor --json
→ ready=false：docs-only，展示 reasonCode/remediation
→ ready=true：按当前状态构造一个 RuntimeRequestEnvelope
→ JSON 只经 stdin 传给 repo-e2e rpc
→ 原样转述 Runtime state/digest/next edge/minimum missing input
```

缺 Runtime 时安装建议必须是精确版本：

```bash
npm exec --yes --package=@mutil-skills/e2e-runtime@0.1.0 -- repo-e2e install-runtime --version 0.1.0
```

Skill 不得自行执行该命令，不得把 PRD/path/selector/secret 拼入 shell，不得计算 digest/verdict/coverage。审批子流程必须明确让 Runtime 打开 WebAuthn session；secret 子流程只引用 `secretRef`。

- [ ] **Step 5: 检查所有 15 个 Markdown 的主要语言和协议一致性**

Run: `rg -L "repo-e2e|Runtime" packages/skills/skills/testing/e2e/*.md`

Expected: 只允许纯领域说明且无需 Runtime 调用的文件出现；入口与上述 10 个相关子 Skill 必须命中。

Run: `rg -n "import .*@mutil-skills/e2e-|npx .*e2e-(contracts|engine|authority|gateway|report|playwright)" packages/skills/skills/testing/e2e`

Expected: 无输出。

- [ ] **Step 6: 运行 GREEN 验证**

Run: `npx vitest run packages/schema/test/skill-manifest.test.ts packages/skills/test/e2e-skill.test.ts`

Expected: PASS。

Run: `npm run typecheck && npm run lint:architecture`

Expected: PASS。

- [ ] **Step 7: 提交 Skill 集成**

```bash
git add packages/schema packages/skills
git commit -m "feat(e2e): route the skill through the runtime host"
```

---

### Task 12: 空白项目跨仓 Golden、统一版本与发行门禁

**Files:**
- Create: `scripts/e2e-runtime-cross-repo.ts`
- Create: `scripts/e2e-runtime-cross-repo.golden.test.ts`
- Create: `scripts/e2e-runtime-package.test.ts`
- Create: `scripts/e2e-runtime-security-matrix.test.ts`
- Modify: `scripts/package-metadata.test.ts`
- Modify: `scripts/check-architecture.mjs`
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `packages/e2e-contracts/package.json`
- Modify: `packages/e2e-engine/package.json`
- Modify: `packages/e2e-authority/package.json`
- Modify: `packages/e2e-gateway/package.json`
- Modify: `packages/e2e-playwright-runtime/package.json`
- Modify: `packages/e2e-report/package.json`
- Modify: `packages/e2e-runtime/package.json`
- Modify: `README.md`
- Create: `CHANGELOG.md`

**Interfaces:**
- Consumes: 完整 Runtime tarball、固定 launcher、Skill tarball、fixture app、真实 Chromium。
- Produces: source-independent Golden、package closure proof、`0.1.0` 一版本闭包和发布前审查证据。
- Produces test driver: `runCrossRepoRuntimeGolden(input: { home: string; project: string; packs: string }): Promise<CrossRepoRuntimeGoldenResult>`。
- 不执行 `npm publish`、tag、push。

- [ ] **Step 1: 写跨仓 Golden 测试并确认 RED**

```ts
import { mkdtemp, readFile, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { runCrossRepoRuntimeGolden } from './e2e-runtime-cross-repo.js'

describe('portable E2E runtime', () => {
  test('runs from packed artifacts in a blank project without source paths', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mutil-e2e-cross-repo-'))
    const home = join(root, 'home')
    const project = join(root, 'user-project')
    const packs = join(root, 'packs')
    const result = await runCrossRepoRuntimeGolden({ home, project, packs })

    expect(result.doctor.ready).toBe(true)
    expect(result.report.content.verdict).toBe('accepted')
    expect(result.report.content.runtimeProvenance.sourceRepositoryIndependent).toBe(true)
    expect(result.publishedRegression).toMatchObject({ exitCode: 0 })
    expect(result.publishedRegression.gatewayAuditDigest).toMatch(/^sha256:/)
    expect(result.tracePath).toEqual([
      'PRD-ORDER-1', 'REQ-ORDER-1', 'RULE-ORDER-1', 'COV-ORDER-1',
      'CASE-ORDER-1', 'ACTION-ORDER-1', 'EVIDENCE-ORDER-1', 'accepted',
    ])
    const published = await readdir(join(project, '.biztest'), { recursive: true })
    expect(published.some((path) => String(path).includes('quarantine'))).toBe(false)
    expect(await readFile(result.reportPath, 'utf8')).not.toContain(process.cwd())
  }, 180_000)
})
```

`scripts/e2e-runtime-cross-repo.ts` 必须完整实现 driver，且不得 import 任一 workspace Runtime 模块：

1. 在当前仓库运行 clean build；复制构建后的发布所需文件到本次测试专属 `root/publication-source`，排除 `.git`、`node_modules`、用户配置和证据文件。
2. 在该临时发布源运行 workspace pack，把 tarball 写入位于其目录之外的 `packs`；随后把临时发布源重命名为 `publication-source.unavailable`。绝不移动或重命名当前真实仓库。
3. 用全部本地 tarball 在 temp HOME 的版本目录安装 Runtime/Skill，创建固定 launcher；安装完成后，所有子进程的 cwd 设为无 `package.json`/`node_modules` 的 `project`。
4. 构造白名单环境，删除 `NODE_PATH`、`NODE_OPTIONS` 和所有非测试 secret；通过 launcher 依次执行 doctor、fixture PRD intake、测试专用独立审批适配器、真实 Browser/Gateway，并生成同代 regression source。
5. 在独立的低权限 child 中对已生成的 regression 执行 `playwright test`：临时 HOME、空 secret env、禁止项目外文件、目标网络仍强制经过本次 Gateway。该结果只证明发布资产可运行，不回写或替代固定 Runner 的权威 BrowserResult/Verdict；随后完成 generation 发布与 report。
6. `CrossRepoRuntimeGoldenResult` 精确返回测试读取的 `doctor`、`report`、`tracePath`、`reportPath`，并额外返回 `publishedRegression: { exitCode: 0; gatewayAuditDigest: string }` 供测试断言。driver 在 `finally` 中关闭进程并删除临时安装；临时发布源保持不可用直到所有断言结束。

通过 child-process stdout JSON 解析结果，不得从 workspace import Runtime 代码，也不得把真实仓库路径加入 PATH、`NODE_PATH` 或 launcher。

- [ ] **Step 2: 运行跨仓测试并确认 RED**

Run: `npx vitest run --config vitest.e2e.config.ts scripts/e2e-runtime-cross-repo.golden.test.ts`

Expected: FAIL，跨仓 Golden/helper 尚不存在或 package 版本未统一。

- [ ] **Step 3: 统一七个 E2E 包版本为 0.1.0**

把 Runtime、Contracts、Engine、Authority、Gateway、Playwright Runtime、Report 的 `version` 改为 `0.1.0`，内部 dependency 全改为精确 `0.1.0`。运行：

Run: `npm install --package-lock-only`

Expected: lockfile 中七个 workspace 版本/内部依赖一致；第三方实际版本固定。

新增 package metadata 测试枚举七包，断言同版、无 `workspace:*`/`latest`/内部 caret；Runtime tarball 必须含 bin、assets、Python helper、WebAuthn bundle和所有 production dependency。

- [ ] **Step 4: 完成安全矩阵**

`scripts/e2e-runtime-security-matrix.test.ts` 逐项覆盖并断言稳定 reason code：

```text
恶意 PRD shell 文本
path traversal / symlink swap / hardlink
恶意 project node_modules / NODE_PATH / NODE_OPTIONS
SSH key canary / env secret / project .env
Gateway 直连 / 未批准 redirect / WebSocket / Beacon / Service Worker
审批 challenge 错绑 / stale / replay / 无 UV
Runtime package version skew / manifest tamper
raw evidence canary / report absolute path
Host crash / effect unknown / publication kill point
同版安装内容冲突 / active version 卸载 / 缺失 state 迁移器
```

每个 case 必须验证 fail closed 终态，不能只验证抛异常。

- [ ] **Step 5: 完成 README 与 Changelog**

README 增加精确用户流程：安装 Skill→显式安装 Runtime→安装 Chromium→identity enroll→doctor→在用户项目运行→查看 `.biztest` 报告。明确“Host/Gateway 是本地临时进程，不是远程后端”“首期只支持 macOS/Linux + Chromium”。

`CHANGELOG.md` 增加：

```markdown
# Changelog

## [0.1.0] - 2026-07-16

### Added
- 用户级隔离 E2E Runtime Host、固定 `repo-e2e` 协议和空白项目运行能力。
- 独立 WebAuthn Approval Authority、HTTPS/WebSocket Gateway 与受控 Chromium。
- PRD 到同代回归资产和可追踪报告的完整发布闭环。

### Fixed
- Skill 安装后仍依赖源码仓库和项目本地 E2E package 的可移植性缺陷。

### Security
- 权威执行不加载生成源码；测试进程不继承宿主秘密或项目依赖。
- 浏览器目标流量默认拒绝并强制经过 Gateway；原始证据只进入 Git 外加密 Quarantine。

### Changed
- E2E Skill 从七个低层 package capability 切换到单一 `e2e.runtime-host` 能力门。

### Migration
- 旧 E2E Skill 可继续作为文档读取；要执行受信验收，必须显式安装精确 `0.1.0` Runtime、Chromium 并完成本地 identity enrollment。
- 首发不重写既有 active generation；未知 Runtime state schema 会以 `migration-required` 阻塞。
```

- [ ] **Step 6: 实际 pack 与隔离安装验证**

Run: `npm run build`

Expected: PASS。

Run: `npm pack --dry-run --workspaces`

Expected: 全部 workspace pack 清单无源码缓存、证书、`.env`、测试 fixture 或 raw evidence。

Run: `npm pack --workspaces --pack-destination /private/tmp/mutil-skills-e2e-runtime-qa`

Expected: 生成 tarballs。

Run: `npx vitest run scripts/e2e-runtime-package.test.ts`

Expected: 在隔离 temp HOME 安装/import/`repo-e2e doctor --json` smoke PASS。

- [ ] **Step 7: 全量验证**

Run: `npm test`

Expected: 全部 unit/integration PASS；既有 skipped 只能是已登记的真实浏览器环境项。

Run: `npm run typecheck`

Expected: PASS。

Run: `npm run build`

Expected: PASS。

Run: `npm run lint:architecture`

Expected: PASS。

Run: `npm run e2e:golden`

Expected: 既有 24 个 Golden 加新增 cross-repo Golden 全部 PASS。

Run: `git diff --check && git status --short`

Expected: 无空白错误；只包含本计划范围内的待提交变更。

- [ ] **Step 8: 执行最终代码审查**

使用 `code-review` 对从 `c156f6e` 到当前 HEAD 的实现做 Standards + Intent 双轴审查。必须处理所有 P0/P1；P2 若不修复必须记录明确理由。再次运行受影响测试，不以此前结果代替变更后的验证。

- [ ] **Step 9: 提交版本、Golden 和文档**

```bash
git add package.json package-lock.json packages scripts README.md CHANGELOG.md
git commit -m "test(e2e): prove portable runtime from packed artifacts"
```

- [ ] **Step 10: 最终工作区与提交核对**

Run: `git status --short && git log --oneline c156f6e..HEAD`

Expected: 工作区 clean；每个任务形成一个可独立审查和回滚的提交。不得执行 publish、tag 或 push。
