import { RuntimeDoctorReportSchema, canonicalizeJson } from '@mutil-skills/e2e-contracts'
import { Readable, Writable } from 'node:stream'
import { describe, expect, test } from 'vitest'
import { runCli } from '../src/cli.js'
import { runRuntimeBin } from '../src/runtime-bin.js'
import { serializeRuntimeDoctorReport } from '../src/protocol.js'
import {
  RUNTIME_DOCTOR_PROBE_NAMES,
  aggregateDoctorReport,
  runRuntimeDoctor,
  type RuntimeDoctorProbeName,
  type RuntimeProbe,
} from '../src/runtime-doctor.js'
import type { RuntimeInstallation } from '../src/runtime-discovery.js'

const digest = `sha256:${'a'.repeat(64)}`
const installation: RuntimeInstallation = {
  version: '0.0.0',
  protocolMajor: 1,
  versionRoot: '/safe/runtime/versions/0.0.0',
  entrypoint: '/safe/runtime/versions/0.0.0/dist/src/bin/repo-e2e.js',
  installationDigest: digest,
  sourceRepositoryIndependent: true,
}

describe('Runtime doctor', () => {
  test('is ready only when every required probe passes', () => {
    const report = aggregateDoctorReport({
      runtimeVersion: '0.0.0',
      installationDigest: digest,
      probes: {
        installation: {
          status: 'passed',
          reasonCode: 'E2E_RUNTIME_INSTALLATION_OK',
          remediation: '无需处理',
        },
        gateway: {
          status: 'blocked',
          reasonCode: 'E2E_GATEWAY_UNAVAILABLE',
          remediation: '修复 Gateway Runtime',
        },
      },
    })

    expect(report.ready).toBe(false)
  })

  test('runs the fixed registry without claiming later capabilities are installed', async () => {
    const report = await runRuntimeDoctor({ installation })

    expect(Object.keys(report.probes)).toEqual(RUNTIME_DOCTOR_PROBE_NAMES)
    expect(report.probes.installation?.status).toBe('passed')
    expect(report.probes['version-closure']?.status).toBe('passed')
    expect(report.probes['source-independence']?.status).toBe('passed')
    for (const name of RUNTIME_DOCTOR_PROBE_NAMES.slice(3)) {
      expect(report.probes[name]).toMatchObject({ status: 'not-installed' })
    }
    expect(report.ready).toBe(false)
  })

  test('runs each required probe in fixed order and becomes ready only when all pass', async () => {
    const calls: RuntimeDoctorProbeName[] = []
    const probes = Object.fromEntries(RUNTIME_DOCTOR_PROBE_NAMES.map((name) => [
      name,
      async (context) => {
        expect(context.installation).toBe(installation)
        calls.push(name)
        return {
          status: 'passed',
          reasonCode: `E2E_${name.replaceAll('-', '_').toUpperCase()}_OK`,
          proofDigest: digest,
          remediation: '无需处理',
        }
      },
    ])) as Record<RuntimeDoctorProbeName, RuntimeProbe>

    const report = await runRuntimeDoctor({ installation, probes })

    expect(RuntimeDoctorReportSchema.parse(report)).toEqual(report)
    expect(calls).toEqual(RUNTIME_DOCTOR_PROBE_NAMES)
    expect(report.ready).toBe(true)
  })

  test('sanitizes a thrown probe and continues the remaining registry', async () => {
    let gatewayRan = false

    const report = await runRuntimeDoctor({
      installation,
      probes: {
        authority: async () => {
          throw new Error('secret=/Users/person/.ssh/id_ed25519')
        },
        gateway: async () => {
          gatewayRan = true
          return {
            status: 'passed',
            reasonCode: 'E2E_GATEWAY_OK',
            proofDigest: digest,
            remediation: '无需处理',
          }
        },
      },
    })

    expect(report.probes.authority).toEqual({
      status: 'blocked',
      reasonCode: 'E2E_RUNTIME_DOCTOR_PROBE_FAILED',
      remediation: '重新运行 doctor；若问题持续，重新安装 Runtime',
    })
    expect(gatewayRan).toBe(true)
    expect(JSON.stringify(report)).not.toContain('/Users/person')
    expect(report.ready).toBe(false)
  })

  test('doctor --json writes only a schema-valid canonical report to stdout', async () => {
    const report = await allPassedReport()
    const stdout = captureWritable()
    const stderr = captureWritable()
    const calls: unknown[] = []

    const exitCode = await runCli(
      ['doctor', '--json'],
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
        uninstallRuntime: async () => ({ version: '0.0.0' }),
        inspectRuntimeInstallation: async (options) => {
          calls.push(options)
          return installation
        },
        runRuntimeDoctor: async (options) => {
          calls.push(options)
          return report
        },
      },
    )

    expect(exitCode).toBe(0)
    expect(RuntimeDoctorReportSchema.parse(JSON.parse(stdout.text()))).toEqual(report)
    expect(stdout.text()).toBe(`${canonicalizeJson(report)}\n`)
    expect(stderr.text()).toBe('')
    expect(calls).toEqual([{ homeDir: '/safe/home' }, { installation }])
  })

  test('doctor report serialization rejects values outside the protocol schema', async () => {
    const report = await allPassedReport()

    expect(serializeRuntimeDoctorReport(report)).toBe(canonicalizeJson(report))
    expect(() => serializeRuntimeDoctorReport({
      ...report,
      leakedSecret: '/Users/person/.ssh/id_ed25519',
    })).toThrow(expect.objectContaining({
      code: 'E2E_RUNTIME_DOCTOR_REPORT_INVALID',
      category: 'internal',
    }))
  })

  test('human doctor keeps stdout empty and prints a Chinese probe table to stderr', async () => {
    const report = await runRuntimeDoctor({ installation })
    const stdout = captureWritable()
    const stderr = captureWritable()

    const exitCode = await runCli(
      ['doctor'],
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
        uninstallRuntime: async () => ({ version: '0.0.0' }),
        inspectRuntimeInstallation: async () => installation,
        runRuntimeDoctor: async () => report,
      },
    )

    expect(exitCode).toBe(3)
    expect(stdout.text()).toBe('')
    expect(stderr.text()).toContain('探针\t状态\t原因代码\t修复建议')
    expect(stderr.text()).toContain('installation\t通过\tE2E_RUNTIME_INSTALLATION_OK')
    expect(stderr.text()).toContain('authority\t未安装\tE2E_AUTHORITY_NOT_INSTALLED')
    expect(stderr.text()).toContain('就绪：否')
  })

  test('doctor --json sanitizes discovery failure into a strict blocked report', async () => {
    const stdout = captureWritable()
    const stderr = captureWritable()

    const exitCode = await runCli(
      ['doctor', '--json'],
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
        uninstallRuntime: async () => ({ version: '0.0.0' }),
        inspectRuntimeInstallation: async () => {
          const error = new Error('secret=canary path=/Users/person/project')
          error.stack = 'STACK /Users/person/.ssh/id_ed25519'
          throw error
        },
      },
    )

    const report = RuntimeDoctorReportSchema.parse(JSON.parse(stdout.text()))
    expect(exitCode).toBe(3)
    expect(report).toMatchObject({
      ready: false,
      runtimeVersion: '0.0.0',
      installationDigest: `sha256:${'0'.repeat(64)}`,
      probes: {
        installation: {
          status: 'blocked',
          reasonCode: 'E2E_RUNTIME_INSTALLATION_CHECK_FAILED',
          remediation: '重新安装 Runtime 后再次运行 doctor',
        },
      },
    })
    for (const name of RUNTIME_DOCTOR_PROBE_NAMES.slice(1)) {
      expect(report.probes[name]?.status).not.toBe('passed')
    }
    expect(stdout.text()).not.toContain('canary')
    expect(stdout.text()).not.toContain('/Users/person')
    expect(stdout.text()).not.toContain('STACK')
    expect(stderr.text()).toBe('')
  })

  test('doctor --json falls back to a blocked report when report serialization fails', async () => {
    const report = await allPassedReport()
    const stdout = captureWritable()
    const stderr = captureWritable()

    const exitCode = await runCli(
      ['doctor', '--json'],
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
        uninstallRuntime: async () => ({ version: '0.0.0' }),
        inspectRuntimeInstallation: async () => installation,
        runRuntimeDoctor: async () => report,
        serializeRuntimeDoctorReport: () => {
          throw new Error('secret=canary /Users/person/project STACK')
        },
      },
    )

    const blocked = RuntimeDoctorReportSchema.parse(JSON.parse(stdout.text()))
    expect(exitCode).toBe(3)
    expect(blocked.ready).toBe(false)
    expect(blocked.probes.installation?.reasonCode).toBe('E2E_RUNTIME_INSTALLATION_CHECK_FAILED')
    expect(stdout.text()).not.toContain('canary')
    expect(stdout.text()).not.toContain('/Users/person')
    expect(stdout.text()).not.toContain('STACK')
    expect(stderr.text()).toBe('')
  })

  test('human doctor renders a sanitized blocked table when aggregation fails', async () => {
    const stdout = captureWritable()
    const stderr = captureWritable()

    const exitCode = await runCli(
      ['doctor'],
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
        uninstallRuntime: async () => ({ version: '0.0.0' }),
        inspectRuntimeInstallation: async () => installation,
        runRuntimeDoctor: async () => {
          throw new Error('secret=canary /Users/person/project STACK')
        },
      },
    )

    expect(exitCode).toBe(3)
    expect(stdout.text()).toBe('')
    expect(stderr.text()).toContain('installation\t阻塞\tE2E_RUNTIME_INSTALLATION_CHECK_FAILED')
    expect(stderr.text()).toContain('就绪：否')
    expect(stderr.text()).not.toContain('canary')
    expect(stderr.text()).not.toContain('/Users/person')
    expect(stderr.text()).not.toContain('STACK')
  })

  test('runtime bin catches uncaught CLI failures without printing a stack', async () => {
    const stderr = captureWritable()
    const failingStdout = new Writable({
      write(_chunk, _encoding, callback) {
        callback(new Error('secret=canary /Users/person/project STACK'))
      },
    })
    failingStdout.on('error', () => {})

    const exitCode = await runRuntimeBin(
      ['--version'],
      Readable.from([]),
      failingStdout,
      stderr.stream,
    )

    expect(exitCode).toBe(70)
    expect(stderr.text()).toBe('E2E_RUNTIME_INTERNAL_ERROR\n')
    expect(stderr.text()).not.toContain('canary')
    expect(stderr.text()).not.toContain('/Users/person')
    expect(stderr.text()).not.toContain('STACK')
  })
})

async function allPassedReport() {
  const probes = {} as Record<RuntimeDoctorProbeName, RuntimeProbe>
  for (const name of RUNTIME_DOCTOR_PROBE_NAMES) {
    probes[name] = async () => ({
      status: 'passed' as const,
      reasonCode: `E2E_${name.replaceAll('-', '_').toUpperCase()}_OK`,
      proofDigest: digest,
      remediation: '无需处理',
    })
  }
  return runRuntimeDoctor({ installation, probes })
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
