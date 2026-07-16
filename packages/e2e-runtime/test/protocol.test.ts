import { Readable, Writable } from 'node:stream'
import {
  E2EError,
  RuntimeResponseEnvelopeSchema,
  canonicalizeJson,
  type RuntimeResponseEnvelope,
} from '@mutil-skills/e2e-contracts'
import { describe, expect, test } from 'vitest'
import { runCli } from '../src/cli.js'
import {
  exitCodeForResponse,
  parseRuntimeRequest,
  runtimeErrorResponse,
} from '../src/protocol.js'

const digest = `sha256:${'0'.repeat(64)}`
const installRemediation = 'npm exec --yes --package=@mutil-skills/e2e-runtime@0.0.0 -- repo-e2e install-runtime --version 0.0.0'
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
      runtime: { version: '0.0.0', installationDigest: digest },
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
  test('prints only the package version for --version', async () => {
    const stdout = captureWritable()
    const stderr = captureWritable()

    const exitCode = await runCli(['--version'], Readable.from([]), stdout.stream, stderr.stream)

    expect(exitCode).toBe(0)
    expect(stdout.text()).toBe('0.0.0\n')
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
})

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

function successResponse(): RuntimeResponseEnvelope {
  return {
    schemaVersion: '1.0.0',
    requestId: 'REQ-1',
    runtime: { version: '0.0.0', installationDigest: digest },
    ok: true,
    result: {},
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
