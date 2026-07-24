import { Readable, Writable } from 'node:stream'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  E2EError,
  RuntimeResponseEnvelopeSchema,
  canonicalizeJson,
  type RuntimeResponseEnvelope,
} from '@mutil-skills/e2e-contracts'
import { describe, expect, test, vi } from 'vitest'
import { runCli } from '../src/cli.js'
import { authorizeRuntimeWriteProduction } from '../src/runtime-write-production.js'
import { createRuntimeTestRoots } from './fixtures.js'
import {
  exitCodeForResponse,
  parseRuntimeRequest,
  runtimeErrorResponse,
} from '../src/protocol.js'

const digest = `sha256:${'0'.repeat(64)}`
const installRemediation = 'npm exec --yes --package=@mutil-skills/e2e-runtime@0.3.0 -- repo-e2e install-runtime --version 0.3.0'
const doctorRequest = {
  schemaVersion: '1.0.0',
  requestId: 'REQ-1',
  client: { name: 'e2e-skill', version: '0.1.0' },
  command: 'doctor',
  payload: {},
}

describe('Runtime protocol', () => {
  test('parses only schema-valid JSON requests', () => {
    expect(parseRuntimeRequest(JSON.stringify(doctorRequest))).toEqual(doctorRequest)
    expectInvalidRequest(() => parseRuntimeRequest('{'))
    expectInvalidRequest(() => parseRuntimeRequest(JSON.stringify({ ...doctorRequest, callerExecutable: '/bin/sh' })))
  })

  test('classifies an unsupported protocol major without converting it', () => {
    expectRuntimeError(
      () => parseRuntimeRequest(JSON.stringify({ ...doctorRequest, schemaVersion: '2.0.0' })),
      'E2E_RUNTIME_PROTOCOL_MAJOR_UNSUPPORTED',
    )
  })

  test('converts E2E errors to strict runtime responses', () => {
    const response = runtimeErrorResponse('REQ-1', new E2EError({
      code: 'E2E_RUNTIME_NOT_INSTALLED',
      category: 'environment',
      message: 'Runtime 尚未安装',
      retryable: false,
    }))

    expect(RuntimeResponseEnvelopeSchema.parse(response)).toEqual(response)
    expect(response).toMatchObject({
      schemaVersion: '1.0.0',
      requestId: 'REQ-1',
      runtime: { version: '0.3.0', installationDigest: digest },
      ok: false,
      error: {
        code: 'E2E_RUNTIME_NOT_INSTALLED',
        category: 'environment',
        terminalState: 'environment-blocked',
        retryable: false,
        details: { remediation: installRemediation },
      },
    })
  })

  test.each([
    'E2E_RUNTIME_PACKAGE_VERSION_SKEW',
    'E2E_RUNTIME_STATE_MIGRATION_REQUIRED',
  ])('%s 在公开协议中固定映射为 migration-required', (code) => {
    const response = runtimeErrorResponse('REQ-MIGRATION', new E2EError({
      code,
      category: 'safety',
      message: '需要显式迁移',
      retryable: false,
    }))
    expect(response.error).toMatchObject({
      code,
      category: 'migration',
      terminalState: 'migration-required',
      retryable: false,
    })
  })

  test('maps response categories to stable process exit codes', () => {
    expect(exitCodeForResponse(successResponse())).toBe(0)
    expect(exitCodeForResponse(errorResponse('input', 'input-blocked'))).toBe(2)
    expect(exitCodeForResponse(errorResponse('environment', 'environment-blocked'))).toBe(3)
    expect(exitCodeForResponse(errorResponse('automation', 'automation-blocked'))).toBe(3)
    expect(exitCodeForResponse(errorResponse('safety', 'safety-blocked'))).toBe(4)
    expect(exitCodeForResponse(errorResponse('artifact', 'artifact-blocked'))).toBe(5)
    expect(exitCodeForResponse(errorResponse('migration', 'migration-required'))).toBe(5)
    expect(exitCodeForResponse(errorResponse('internal', 'environment-blocked'))).toBe(70)
  })
})

describe('repo-e2e CLI protocol slice', () => {
  test('configure-browser --system delegates only to controlled system Chrome configuration', async () => {
    const stdout = captureWritable()
    const configureSystemBrowser = vi.fn(async (input: {
      homeDir: string; projectRoot: string; executablePath?: string
    }) => ({
      schemaVersion: '1.0.0' as const,
      source: { kind: 'system-chrome' as const, executablePath: input.executablePath ?? '/Applications/Google Chrome' },
      browserVersion: 'Google Chrome 126', executableDigest: `sha256:${'1'.repeat(64)}`,
      runtimeInstallationDigest: digest, controlledLaunchProofDigest: `sha256:${'2'.repeat(64)}`,
      configuredAt: '2026-07-19T00:00:00.000Z',
    }))
    const installChromium = vi.fn()

    const code = await runCli(
      ['configure-browser', '--system', '--executable', '/Applications/Google Chrome'],
      Readable.from([]), stdout.stream, captureWritable().stream,
      { ...minimalCliDependencies(), configureSystemBrowser, installChromium,
        currentWorkingDirectory: () => '/safe/project' },
    )

    expect(code).toBe(0)
    expect(configureSystemBrowser).toHaveBeenCalledWith({
      homeDir: '/safe/home', projectRoot: '/safe/project',
      executablePath: '/Applications/Google Chrome',
    })
    expect(installChromium).not.toHaveBeenCalled()
    expect(JSON.parse(stdout.text())).toMatchObject({ ok: true, result: {
      configured: true, browserSource: 'system-chrome', browserVersion: 'Google Chrome 126',
    } })
  })

  test('configure-approval persists only an exact supported mode', async () => {
    const writeApprovalMode = vi.fn(async () => undefined)
    const stdout = captureWritable()
    expect(await runCli(
      ['configure-approval', '--mode', 'local-confirmation'], Readable.from([]),
      stdout.stream, captureWritable().stream,
      { ...minimalCliDependencies(), writeApprovalMode },
    )).toBe(0)
    expect(writeApprovalMode).toHaveBeenCalledWith('/safe/home', 'local-confirmation')
    expect(JSON.parse(stdout.text())).toEqual({ ok: true, result: {
      configured: true, approvalMode: 'local-confirmation',
    } })

    const invalid = captureWritable()
    expect(await runCli(
      ['configure-approval', '--mode', 'admin'], Readable.from([]), invalid.stream,
      captureWritable().stream, { ...minimalCliDependencies(), writeApprovalMode },
    )).toBe(2)
    expect(JSON.parse(invalid.text())).toMatchObject({ ok: false, error: { code: 'E2E_RUNTIME_REQUEST_INVALID' } })
  })

  test('installed CLI 为 resume-run 打开并关闭 production write recovery', async () => {
    const roots = await createRuntimeTestRoots()
    await mkdir(join(roots.project, '.biztest'), { recursive: true })
    await writeFile(join(roots.project, '.biztest', 'project.json'), JSON.stringify({
      schemaVersion: '1.0.0', projectId: 'PROJECT-CLI-WRITE-RECOVERY',
    }))
    const stdout = captureWritable()
    const stderr = captureWritable()
    const close = vi.fn(async () => undefined)
    const recover = vi.fn(async () => ({ status: 'blocked' as const,
      reasonCode: 'E2E_RUNTIME_WRITE_EFFECT_UNCERTAIN', browserCalls: 0 as const }))
    const openWriteProduction = vi.fn(async () => ({
      capability: authorizeRuntimeWriteProduction({
        recovery: { recover }, ownedResources: { register: vi.fn(), complete: vi.fn() },
        prepareCleanup: vi.fn(),
      }),
      close,
    }))
    const request = {
      schemaVersion: '1.0.0', requestId: 'REQUEST-CLI-WRITE-RECOVERY',
      client: { name: 'e2e-skill', version: '0.1.0' },
      command: 'resume-run', projectRoot: roots.project,
      payload: { runId: 'RUN-WRITE-RECOVERY',
        decision: { kind: 'recover-write-attempt', expectedAttemptId: 'ATTEMPT-WRITE-1' } },
    }
    const dependencies = {
        homeDir: roots.home,
        installRuntime: async () => ({ version: '0.1.0', installationDigest: digest,
          launcher: '/unused' }),
        uninstallRuntime: async () => ({ version: '0.1.0' }),
        inspectRuntimeInstallation: async () => ({
          version: '0.1.0', protocolMajor: 1 as const, versionRoot: roots.root,
          entrypoint: '/unused', installationDigest: digest, sourceRepositoryIndependent: true as const,
        }),
        openWriteProduction,
      }
    const exitCode = await runCli(['rpc'], Readable.from([JSON.stringify(request)]),
      stdout.stream, stderr.stream, dependencies)
    const replayStdout = captureWritable()
    expect(await runCli(['rpc'], Readable.from([JSON.stringify(request)]),
      replayStdout.stream, captureWritable().stream, dependencies)).toBe(0)

    expect(exitCode).toBe(0)
    expect(openWriteProduction).toHaveBeenCalledWith(expect.objectContaining({
      homeDir: roots.home, projectRoot: roots.project,
    }))
    expect(recover).toHaveBeenCalledOnce()
    expect(close).toHaveBeenCalledTimes(2)
    expect(JSON.parse(stdout.text())).toMatchObject({ ok: true, result: {
      status: 'blocked', reasonCode: 'E2E_RUNTIME_WRITE_EFFECT_UNCERTAIN', browserCalls: 0,
    } })
    expect(JSON.parse(replayStdout.text())).toEqual(JSON.parse(stdout.text()))
  })

  test('human report command maps to the same render-report Runtime Host protocol', async () => {
    const stdout = captureWritable()
    const stderr = captureWritable()
    const handle = vi.fn(async (
      request: { requestId: string }, _requestBytes: string | Uint8Array,
    ) => successResponse(request.requestId, {
      generationId: 'RUN-1', report: { markdown: '# report\n' },
    }))

    const exitCode = await runCli(
      ['report', '--run-id', 'RUN-1'], Readable.from([]), stdout.stream, stderr.stream,
      {
        homeDir: '/safe/home',
        installRuntime: async () => ({
          version: '0.0.0', installationDigest: digest, launcher: '/safe/repo-e2e',
        }),
        uninstallRuntime: async () => ({ version: '0.0.0' }),
        runtimeHost: { handle }, currentWorkingDirectory: () => '/safe/project',
      },
    )

    expect(exitCode).toBe(0)
    expect(handle).toHaveBeenCalledOnce()
    expect(handle.mock.calls[0]?.[0]).toMatchObject({
      schemaVersion: '1.0.0', command: 'render-report', projectRoot: '/safe/project',
      payload: { runId: 'RUN-1' },
    })
    expect(handle.mock.calls[0]?.[1]).toEqual(expect.any(Buffer))
    expect(JSON.parse(stdout.text())).toMatchObject({
      ok: true, result: { generationId: 'RUN-1', report: { markdown: '# report\n' } },
    })
    expect(stderr.text()).toBe('')
  })

  test('prints only the package version for --version', async () => {
    const stdout = captureWritable()
    const stderr = captureWritable()

    const exitCode = await runCli(['--version'], Readable.from([]), stdout.stream, stderr.stream)

    expect(exitCode).toBe(0)
    expect(stdout.text()).toBe('0.3.0\n')
    expect(stderr.text()).toBe('')
  })

  test('returns one canonical not-installed response for a valid rpc request', async () => {
    const stdout = captureWritable()
    const stderr = captureWritable()

    const exitCode = await runCli(
      ['rpc'],
      Readable.from([JSON.stringify(doctorRequest)]),
      stdout.stream,
      stderr.stream,
      {
        homeDir: '/safe/uninstalled-home',
        installRuntime: async () => ({
          version: '0.0.0', installationDigest: digest, launcher: '/safe/uninstalled-home/bin/repo-e2e',
        }),
        uninstallRuntime: async () => ({ version: '0.0.0' }),
        inspectRuntimeInstallation: async () => { throw new Error('not installed') },
      },
    )

    const response = RuntimeResponseEnvelopeSchema.parse(JSON.parse(stdout.text()))
    expect(exitCode).toBe(3)
    expect(response).toMatchObject({
      requestId: 'REQ-1',
      ok: false,
      error: {
        code: 'E2E_RUNTIME_NOT_INSTALLED',
        category: 'environment',
        terminalState: 'environment-blocked',
        details: { remediation: installRemediation },
      },
    })
    expect(stdout.text()).toBe(`${canonicalizeJson(response)}\n`)
    expect(stderr.text()).toBe('')
  })

  test('routes a parsed rpc request through the installed Runtime Host', async () => {
    const stdout = captureWritable()
    const stderr = captureWritable()
    const calls: Array<{ request: unknown; requestBytes: unknown }> = []
    const rawRequest = JSON.stringify(doctorRequest)

    const exitCode = await runCli(
      ['rpc'],
      Readable.from([rawRequest]),
      stdout.stream,
      stderr.stream,
      {
        homeDir: '/safe/home',
        installRuntime: async () => ({
          version: '0.0.0', installationDigest: digest, launcher: '/safe/home/bin/repo-e2e',
        }),
        uninstallRuntime: async () => ({ version: '0.0.0' }),
        runtimeHost: {
          handle: async (request, requestBytes) => {
            calls.push({ request, requestBytes })
            return successResponse()
          },
        },
      },
    )

    expect(exitCode).toBe(0)
    expect(calls).toEqual([{ request: doctorRequest, requestBytes: Buffer.from(rawRequest) }])
    expect(stdout.text()).toBe(`${canonicalizeJson(successResponse())}\n`)
    expect(stderr.text()).toBe('')
  })

  test('returns a sanitized input error instead of a stack for invalid rpc JSON', async () => {
    const stdout = captureWritable()
    const stderr = captureWritable()

    const exitCode = await runCli(['rpc'], Readable.from(['{']), stdout.stream, stderr.stream)

    const response = RuntimeResponseEnvelopeSchema.parse(JSON.parse(stdout.text()))
    expect(exitCode).toBe(2)
    expect(response).toMatchObject({
      requestId: 'UNKNOWN',
      ok: false,
      error: {
        code: 'E2E_RUNTIME_REQUEST_INVALID',
        category: 'input',
        terminalState: 'input-blocked',
      },
    })
    expect(stdout.text()).not.toContain('stack')
    expect(stderr.text()).toBe('')
  })

  test('keeps extra envelope fields classified as input errors', async () => {
    const stdout = captureWritable()
    const stderr = captureWritable()

    const exitCode = await runCli(
      ['rpc'],
      Readable.from([JSON.stringify({ ...doctorRequest, callerExecutable: '/bin/sh' })]),
      stdout.stream,
      stderr.stream,
    )

    const response = RuntimeResponseEnvelopeSchema.parse(JSON.parse(stdout.text()))
    expect(exitCode).toBe(2)
    expect(response).toMatchObject({
      requestId: 'REQ-1',
      ok: false,
      error: {
        code: 'E2E_RUNTIME_REQUEST_INVALID',
        category: 'input',
        terminalState: 'input-blocked',
        retryable: false,
      },
    })
    expect(stderr.text()).toBe('')
  })

  test('returns migration-required and exit 5 for an unsupported protocol major', async () => {
    const stdout = captureWritable()
    const stderr = captureWritable()

    const exitCode = await runCli(
      ['rpc'],
      Readable.from([JSON.stringify({ ...doctorRequest, schemaVersion: '2.0.0' })]),
      stdout.stream,
      stderr.stream,
    )

    const response = RuntimeResponseEnvelopeSchema.parse(JSON.parse(stdout.text()))
    expect(exitCode).toBe(5)
    expect(response).toMatchObject({
      requestId: 'REQ-1',
      ok: false,
      error: {
        code: 'E2E_RUNTIME_PROTOCOL_MAJOR_UNSUPPORTED',
        category: 'migration',
        terminalState: 'migration-required',
        retryable: false,
      },
    })
    expect(stderr.text()).toBe('')
  })

  test('installs only an exact requested runtime version and prints bounded installation metadata', async () => {
    const stdout = captureWritable()
    const stderr = captureWritable()
    const calls: unknown[] = []

    const exitCode = await runCli(
      ['install-runtime', '--version', '0.0.0'],
      Readable.from([]),
      stdout.stream,
      stderr.stream,
      {
        homeDir: '/safe/home',
        installRuntime: async (options) => {
          calls.push(options)
          return {
            version: '0.0.0',
            installationDigest: digest,
            launcher: '/safe/home/.mutil-skills/bin/repo-e2e',
          }
        },
        uninstallRuntime: async () => ({ version: '0.0.0' }),
      },
    )

    expect(exitCode).toBe(0)
    expect(calls).toEqual([{ homeDir: '/safe/home', version: '0.0.0' }])
    expect(stdout.text()).toBe(`${canonicalizeJson({
      version: '0.0.0',
      installationDigest: digest,
      launcher: '/safe/home/.mutil-skills/bin/repo-e2e',
    })}\n`)
    expect(stdout.text()).not.toContain('cache')
    expect(stderr.text()).toBe('')
  })

  test('rejects missing, floating, and purge install-management arguments with exit 2', async () => {
    const invocations = [
      ['install-runtime'],
      ['install-runtime', '--version', 'latest'],
      ['uninstall-runtime', '--version', '0.0.0', '--purge-state'],
      ['uninstall-runtime', '--version', '0.0.0', '--purge-quarantine'],
      ['uninstall-runtime', '--version', '0.0.0', '--purge-identity'],
    ]
    for (const arguments_ of invocations) {
      const stdout = captureWritable()
      const stderr = captureWritable()
      const exitCode = await runCli(arguments_, Readable.from([]), stdout.stream, stderr.stream)
      const response = RuntimeResponseEnvelopeSchema.parse(JSON.parse(stdout.text()))
      expect(exitCode).toBe(2)
      expect(response.error).toMatchObject({
        code: 'E2E_RUNTIME_INSTALL_ARGUMENT_INVALID',
        category: 'input',
      })
      expect(stderr.text()).toBe('')
    }
  })

  test('passes an exact replacement only to explicit runtime uninstall', async () => {
    const stdout = captureWritable()
    const stderr = captureWritable()
    const calls: unknown[] = []

    const exitCode = await runCli(
      ['uninstall-runtime', '--version', '0.0.0', '--activate', '0.0.1'],
      Readable.from([]),
      stdout.stream,
      stderr.stream,
      {
        homeDir: '/safe/home',
        installRuntime: async () => ({
          version: '0.0.0',
          installationDigest: digest,
          launcher: '/safe/home/.mutil-skills/bin/repo-e2e',
        }),
        uninstallRuntime: async (options) => {
          calls.push(options)
          return { version: '0.0.0', activeVersion: '0.0.1' }
        },
      },
    )

    expect(exitCode).toBe(0)
    expect(calls).toEqual([{
      homeDir: '/safe/home',
      version: '0.0.0',
      activateVersion: '0.0.1',
    }])
    expect(JSON.parse(stdout.text())).toEqual({ version: '0.0.0', activeVersion: '0.0.1' })
    expect(stderr.text()).toBe('')
  })

  test('human identity and explicitly typed approval commands print the URL to stderr and wait', async () => {
    for (const arguments_ of [
      ['identity', 'enroll'],
      ['approve', '--run-id', 'RUN-1', '--type', 'lineage'],
      ['approve', '--run-id', 'RUN-1', '--type', 'execution', '--subject-file', 'e2e/execution-subject.json'],
    ]) {
      const stdout = captureWritable()
      const stderr = captureWritable()
      const wait = vi.fn(async () => undefined)
      const openHumanAuthoritySession = vi.fn(async () => ({
        url: `http://localhost:43123/#${'s'.repeat(43)}`,
        sessionId: 'SESSION-1',
        wait,
      }))
      const exitCode = await runCli(arguments_, Readable.from([]), stdout.stream, stderr.stream, {
        homeDir: '/safe/home',
        installRuntime: async () => ({
          version: '0.0.0', installationDigest: digest, launcher: '/safe/repo-e2e',
        }),
        uninstallRuntime: async () => ({ version: '0.0.0' }),
        openHumanAuthoritySession,
        readHumanRunApprovalMode: async () => 'webauthn' as const,
      })
      expect(exitCode).toBe(0)
      expect(openHumanAuthoritySession).toHaveBeenCalledWith(arguments_)
      expect(stderr.text()).toBe(`http://localhost:43123/#${'s'.repeat(43)}\n`)
      expect(wait).toHaveBeenCalledOnce()
      expect(JSON.parse(stdout.text())).toEqual({ sessionId: 'SESSION-1', status: 'verified' })
    }
  })

  test('human approval command rejects an omitted approval type instead of guessing from workflow', async () => {
    const stdout = captureWritable()
    const stderr = captureWritable()
    const openHumanAuthoritySession = vi.fn()

    const exitCode = await runCli(
      ['approve', '--run-id', 'RUN-1'],
      Readable.from([]), stdout.stream, stderr.stream,
      {
        homeDir: '/safe/home',
        installRuntime: async () => ({
          version: '0.0.0', installationDigest: digest, launcher: '/safe/repo-e2e',
        }),
        uninstallRuntime: async () => ({ version: '0.0.0' }),
        openHumanAuthoritySession,
      },
    )

    expect(exitCode).toBe(2)
    expect(openHumanAuthoritySession).not.toHaveBeenCalled()
    expect(JSON.parse(stdout.text())).toMatchObject({
      ok: false, error: { code: 'E2E_RUNTIME_REQUEST_INVALID' },
    })
  })

  test('默认本地确认模式下 direct approve 不得伪装成 WebAuthn session', async () => {
    const stdout = captureWritable()
    const stderr = captureWritable()
    const openHumanAuthoritySession = vi.fn()

    const exitCode = await runCli(
      ['approve', '--run-id', 'RUN-1', '--type', 'lineage'],
      Readable.from([]), stdout.stream, stderr.stream,
      { ...minimalCliDependencies(), openHumanAuthoritySession,
        readHumanRunApprovalMode: async () => 'local-confirmation' as const },
    )

    expect(exitCode).toBe(2)
    expect(openHumanAuthoritySession).not.toHaveBeenCalled()
    expect(stderr.text()).toBe('')
    expect(JSON.parse(stdout.text())).toMatchObject({
      ok: false, error: { code: 'E2E_LOCAL_APPROVAL_RPC_REQUIRED' },
    })
  })

  test('Discovery/Execution 人类审批缺少 subject-file 时不进入 Authority', async () => {
    const stdout = captureWritable()
    const stderr = captureWritable()
    const openHumanAuthoritySession = vi.fn()

    const exitCode = await runCli(
      ['approve', '--run-id', 'RUN-1', '--type', 'execution'],
      Readable.from([]), stdout.stream, stderr.stream,
      {
        homeDir: '/safe/home',
        installRuntime: async () => ({
          version: '0.0.0', installationDigest: digest, launcher: '/safe/repo-e2e',
        }),
        uninstallRuntime: async () => ({ version: '0.0.0' }),
        openHumanAuthoritySession,
      },
    )

    expect(exitCode).toBe(2)
    expect(openHumanAuthoritySession).not.toHaveBeenCalled()
    expect(JSON.parse(stdout.text())).toMatchObject({
      ok: false, error: { code: 'E2E_RUNTIME_REQUEST_INVALID' },
    })
  })
})

function minimalCliDependencies() {
  return {
    homeDir: '/safe/home',
    installRuntime: async () => ({ version: '0.1.0', installationDigest: digest, launcher: '/safe/repo-e2e' }),
    uninstallRuntime: async () => ({ version: '0.1.0' }),
  }
}

function expectInvalidRequest(parse: () => unknown): void {
  expectRuntimeError(parse, 'E2E_RUNTIME_REQUEST_INVALID', 'input')
}

function expectRuntimeError(parse: () => unknown, code: string, category?: string): void {
  try {
    parse()
    throw new Error('expected parseRuntimeRequest to throw')
  } catch (error) {
    expect(error).toBeInstanceOf(E2EError)
    expect(error).toMatchObject({
      code,
      ...(category === undefined ? {} : { category }),
      retryable: false,
    })
  }
}

function successResponse(
  requestId = 'REQ-1',
  result: RuntimeResponseEnvelope['result'] = {},
): RuntimeResponseEnvelope {
  return {
    schemaVersion: '1.0.0',
    requestId,
    runtime: { version: '0.0.0', installationDigest: digest },
    ok: true,
    result,
  }
}

function errorResponse(
  category: 'input' | 'environment' | 'safety' | 'automation' | 'artifact' | 'migration' | 'internal',
  terminalState: 'input-blocked' | 'environment-blocked' | 'safety-blocked' | 'automation-blocked' | 'artifact-blocked' | 'migration-required',
): RuntimeResponseEnvelope {
  return {
    schemaVersion: '1.0.0',
    requestId: 'REQ-1',
    runtime: { version: '0.0.0', installationDigest: digest },
    ok: false,
    error: {
      code: 'E2E_TEST_ERROR',
      category,
      terminalState,
      message: 'test error',
      retryable: false,
    },
  }
}

function captureWritable(): { stream: Writable; text: () => string } {
  const chunks: Buffer[] = []
  return {
    stream: new Writable({
      write(chunk, _encoding, callback) {
        chunks.push(Buffer.from(chunk))
        callback()
      },
    }),
    text: () => Buffer.concat(chunks).toString('utf8'),
  }
}
