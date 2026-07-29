import { RuntimeDoctorReportSchema, canonicalizeJson } from '@mutil-skills/e2e-contracts'
import { cp, mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
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
import { inspectRuntimeInstallation } from '../src/runtime-discovery.js'
import { installRuntime } from '../src/runtime-installer.js'
import { openRuntimeArtifactStoreAuthority } from '../src/authority-host.js'
import { createRuntimeTestRoots } from './fixtures.js'
import { writeBrowserSelection } from '../src/runtime-user-config.js'
import { inspectSystemChrome, systemChromeClosureDigest } from '../src/system-chrome.js'
import { recordRuntimeCapabilityProof } from '../src/runtime-capability-proof.js'

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

  test('missing Runtime bytes cannot be reported as passed from an injected installation object', async () => {
    const report = await runRuntimeDoctor({ installation, homeDir: '/safe/home' })

    expect(Object.keys(report.probes)).toEqual(RUNTIME_DOCTOR_PROBE_NAMES)
    expect(report.probes.installation?.status).toBe('blocked')
    expect(report.probes['version-closure']?.status).toBe('blocked')
    expect(report.probes['source-independence']?.status).toBe('blocked')
    for (const name of ['installation', 'version-closure', 'source-independence'] as const) {
      expect(report.probes[name]?.proofDigest).toBeUndefined()
    }
    for (const name of RUNTIME_DOCTOR_PROBE_NAMES.slice(3)
      .filter((name) => !['environment', 'authority', 'artifact-fs', 'chromium'].includes(name))) {
      expect(['not-installed', 'blocked']).toContain(report.probes[name]?.status)
    }
    expect(report.probes.environment?.status).toBe('passed')
    expect(['not-installed', 'blocked']).toContain(report.probes.chromium?.status)
    for (const name of ['authority', 'artifact-fs'] as const) {
      expect(['not-installed', 'blocked']).toContain(report.probes[name]?.status)
      if (report.probes[name]?.status === 'passed') {
        expect(report.probes[name]?.proofDigest).toMatch(/^sha256:[a-f0-9]{64}$/)
      }
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

    const report = await runRuntimeDoctor({ installation, homeDir: '/safe/home', probes })

    expect(RuntimeDoctorReportSchema.parse(report)).toEqual(report)
    expect(calls).toEqual(RUNTIME_DOCTOR_PROBE_NAMES)
    expect(report.ready).toBe(true)
  })

  test('在任何业务探针前明确报告不支持的 Node，而不是产生底层 sqlite 失败', async () => {
    const probes = Object.fromEntries(RUNTIME_DOCTOR_PROBE_NAMES
      .filter((name) => name !== 'environment')
      .map((name) => [name, passedProbe(`E2E_${name.replaceAll('-', '_').toUpperCase()}_OK`)]))

    const report = await runRuntimeDoctor({
      installation,
      homeDir: '/safe/home',
      probes,
      environment: { platform: 'darwin', nodeVersion: '20.19.5', tempDir: '/tmp' },
    })

    expect(report.probes.environment).toEqual({
      status: 'blocked',
      reasonCode: 'E2E_RUNTIME_NODE_VERSION_UNSUPPORTED',
      remediation: '安装 Node.js 22.13.0 或更高版本后重新安装 Runtime',
    })
    expect(report.ready).toBe(false)
  })

  test('system Chrome selection makes browser, Gateway and isolation probes pass without managed Chromium', async () => {
    const roots = await createRuntimeTestRoots()
    const chrome = join(roots.source, 'Google Chrome')
    await writeFile(chrome, 'system chrome bytes', { mode: 0o700 })
    const readVersion = async () => 'Google Chrome 126.0.6478.127'
    const inspected = await inspectSystemChrome({
      executablePath: chrome, projectRoot: roots.project,
      runtimeInstallationDigest: installation.installationDigest,
      controlledLaunchProofDigest: `sha256:${'0'.repeat(64)}`,
      configuredAt: '2026-07-19T00:00:00.000Z', readVersion,
    })
    await writeBrowserSelection(roots.home, inspected.selection)
    const proof = await recordRuntimeCapabilityProof({
      homeDir: roots.home, runtimeInstallationDigest: installation.installationDigest,
      gateway: { sessionMeasurementDigest: digest, policyDigest: digest, auditDigest: digest },
      isolation: {
        browserMeasurementDigest: digest, sandboxProfileDigest: digest, canaryProofDigest: digest,
        browserClosureDigest: systemChromeClosureDigest(inspected),
        browserExecutableDigest: inspected.selection.executableDigest,
      },
      verifiedAt: new Date().toISOString(),
    })
    await writeBrowserSelection(roots.home, {
      ...inspected.selection, controlledLaunchProofDigest: proof.proofDigest,
    })
    const probes = Object.fromEntries(RUNTIME_DOCTOR_PROBE_NAMES
      .filter((name) => !['chromium', 'gateway', 'isolation'].includes(name))
      .map((name) => [name, passedProbe(`E2E_${name.replaceAll('-', '_').toUpperCase()}_OK`)]))

    const report = await runRuntimeDoctor({
      installation, homeDir: roots.home, probes, systemChromeVersionReader: readVersion,
      gatewayPathInspector: async () => undefined,
    })

    expect(report.browserSource).toBe('system-chrome')
    expect(report.probes.chromium).toMatchObject({ status: 'passed', reasonCode: 'E2E_SYSTEM_CHROME_SELECTION_OK' })
    expect(report.probes.gateway?.status).toBe('passed')
    expect(report.probes.isolation?.status).toBe('passed')
    expect(report.ready).toBe(true)
  })

  test('Gateway probe revalidates current installed paths instead of trusting cached proof alone', async () => {
    let inspected = false
    const probes = Object.fromEntries(RUNTIME_DOCTOR_PROBE_NAMES
      .filter((name) => name !== 'gateway')
      .map((name) => [name, passedProbe(`E2E_${name.replaceAll('-', '_').toUpperCase()}_OK`)]))

    const report = await runRuntimeDoctor({
      installation,
      homeDir: '/safe/home',
      probes,
      gatewayPathInspector: async (candidate, homeDir) => {
        expect(candidate).toBe(installation)
        expect(homeDir).toBe('/safe/home')
        inspected = true
        const error = new Error('E2E_GATEWAY_PATH_UNAVAILABLE') as Error & { code: string }
        error.code = 'E2E_GATEWAY_PATH_UNAVAILABLE'
        throw error
      },
    })

    expect(inspected).toBe(true)
    expect(report.probes.gateway).toMatchObject({
      status: 'blocked',
      reasonCode: 'E2E_GATEWAY_PATH_UNAVAILABLE',
    })
  })

  test('真实 Authority、Artifact、Quarantine 与 Report 探针不再是永久占位', async () => {
    const roots = await createRuntimeTestRoots()
    try {
      const source = join(roots.source, 'closure')
      const packageRoot = join(source, 'node_modules', '@mutil-skills', 'e2e-runtime')
      await mkdir(join(packageRoot, 'dist', 'src', 'bin'), { recursive: true })
      await writeFile(join(packageRoot, 'package.json'), JSON.stringify({
        name: '@mutil-skills/e2e-runtime', version: '0.1.0',
      }))
      await writeFile(join(packageRoot, 'dist', 'src', 'bin', 'repo-e2e.js'), '#!/usr/bin/env node\n')
      await installRuntime({
        homeDir: roots.home, version: '0.1.0',
        installClosure: async ({ stagingPrefix }) => await cp(source, stagingPrefix, { recursive: true }),
      })
      const installed = await inspectRuntimeInstallation({ homeDir: roots.home })
      const authority = await openRuntimeArtifactStoreAuthority({
        homeDir: roots.home,
        installation: installed,
        subject: `local:uid:${process.getuid!()}`,
      })
      await authority.close()

      const report = await runRuntimeDoctor({
        installation: installed,
        homeDir: roots.home,
        probes: {
          gateway: passedProbe('E2E_GATEWAY_OK'),
          chromium: passedProbe('E2E_CHROMIUM_OK'),
          isolation: passedProbe('E2E_ISOLATION_OK'),
        },
      })

      expect(report.probes.authority?.status).toBe('passed')
      expect(report.probes['artifact-fs']?.status).toBe('passed')
      expect(report.probes.quarantine?.status).toBe('passed')
      expect(report.probes.report?.status).toBe('passed')
      expect(report.probes['approval-presence']).toMatchObject({
        status: 'passed', reasonCode: 'E2E_LOCAL_CONFIRMATION_READY',
      })
      expect(report.approvalMode).toBe('local-confirmation')
      expect(report.ready).toBe(true)
    } finally { await rm(roots.root, { recursive: true, force: true }) }
  })

  test('sanitizes a thrown probe and continues the remaining registry', async () => {
    let gatewayRan = false

    const report = await runRuntimeDoctor({
      installation,
      homeDir: '/safe/home',
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

  test('保留可安全公开的环境 reasonCode，避免把 Gateway 路径错误压成通用失败', async () => {
    const report = await runRuntimeDoctor({
      installation,
      homeDir: '/safe/home',
      probes: {
        gateway: async () => {
          throw Object.assign(new Error('private path omitted'), { code: 'E2E_GATEWAY_PATH_UNAVAILABLE' })
        },
      },
    })

    expect(report.probes.gateway).toEqual({
      status: 'blocked',
      reasonCode: 'E2E_GATEWAY_PATH_UNAVAILABLE',
      remediation: '修复该探针后重新运行 doctor',
    })
    expect(JSON.stringify(report)).not.toContain('private path omitted')
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
    expect(calls).toEqual([{ homeDir: '/safe/home' }, { installation, homeDir: '/safe/home' }])
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
    const report = await runRuntimeDoctor({ installation, homeDir: '/safe/home' })
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
    const installationProbe = report.probes.installation!
    expect(stderr.text()).toContain(`installation\t阻塞\t${installationProbe.reasonCode}`)
    const authority = report.probes.authority!
    const authorityStatus = authority.status === 'passed' ? '通过' : '阻塞'
    expect(stderr.text()).toContain(`authority\t${authorityStatus}\t${authority.reasonCode}`)
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
      runtimeVersion: '0.4.1',
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
  return runRuntimeDoctor({ installation, homeDir: '/safe/home', probes })
}

function passedProbe(reasonCode: string): RuntimeProbe {
  return async () => ({
    status: 'passed', reasonCode, proofDigest: digest, remediation: '无需处理',
  })
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
