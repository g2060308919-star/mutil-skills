import { chmod, link, readFile, stat, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { Readable, Writable } from 'node:stream'
import { createRuntimeTestRoots } from './fixtures.js'
import { RuntimeRunStore } from '../src/run-store.js'
import {
  inspectRuntimeCapabilityProof,
  recordRuntimeCapabilityProof,
} from '../src/runtime-capability-proof.js'
import { runtimeLayout } from '../src/runtime-layout.js'
import { runCli } from '../src/cli.js'

const d = (character: string) => `sha256:${character.repeat(64)}`

describe('Runtime capability proof', () => {
  test('真实会话写入的 proof 可只读复验 installation/gateway/isolation 绑定', async () => {
    const roots = await createRuntimeTestRoots()
    const store = await RuntimeRunStore.open({ homeDir: roots.home, projectRoot: roots.project })
    await store.close()
    const proof = await recordRuntimeCapabilityProof(proofInput(roots.home))

    await expect(inspectRuntimeCapabilityProof({
      homeDir: roots.home, runtimeInstallationDigest: d('a'),
    })).resolves.toEqual(proof)
  })

  test('inspect 对权限/正文篡改 fail closed 且绝不修复现场', async () => {
    const roots = await createRuntimeTestRoots()
    const store = await RuntimeRunStore.open({ homeDir: roots.home, projectRoot: roots.project })
    await store.close()
    await recordRuntimeCapabilityProof(proofInput(roots.home))
    const path = join(runtimeLayout(roots.home).state, 'runtime-capability-proof.json')
    const original = await readFile(path, 'utf8')
    await chmod(path, 0o644)

    await expect(inspectRuntimeCapabilityProof({
      homeDir: roots.home, runtimeInstallationDigest: d('a'),
    })).rejects.toMatchObject({ code: 'E2E_RUNTIME_CAPABILITY_PROOF_UNSAFE' })
    expect((await stat(path)).mode & 0o777).toBe(0o644)
    expect(await readFile(path, 'utf8')).toBe(original)

    await chmod(path, 0o600)
    await writeFile(path, original.replace(d('b'), d('f')), { mode: 0o600 })
    await expect(inspectRuntimeCapabilityProof({
      homeDir: roots.home, runtimeInstallationDigest: d('a'),
    })).rejects.toMatchObject({ code: 'E2E_RUNTIME_CAPABILITY_PROOF_DIGEST_MISMATCH' })
  })

  test('拒绝 hardlink、未来 proof 与超过 24 小时的 stale proof', async () => {
    const roots = await createRuntimeTestRoots()
    const store = await RuntimeRunStore.open({ homeDir: roots.home, projectRoot: roots.project })
    await store.close()
    const path = join(runtimeLayout(roots.home).state, 'runtime-capability-proof.json')
    await recordRuntimeCapabilityProof(proofInput(roots.home))
    const alias = join(runtimeLayout(roots.home).state, 'proof-hardlink-canary')
    await link(path, alias)
    await expect(inspectRuntimeCapabilityProof({
      homeDir: roots.home, runtimeInstallationDigest: d('a'),
      now: new Date('2026-07-17T01:00:00.000Z'),
    })).rejects.toMatchObject({ code: 'E2E_RUNTIME_CAPABILITY_PROOF_UNSAFE' })
    await unlink(alias)

    await expect(inspectRuntimeCapabilityProof({
      homeDir: roots.home, runtimeInstallationDigest: d('a'),
      now: new Date('2026-07-16T23:59:59.000Z'),
    })).rejects.toMatchObject({ code: 'E2E_RUNTIME_CAPABILITY_PROOF_STALE' })
    await expect(inspectRuntimeCapabilityProof({
      homeDir: roots.home, runtimeInstallationDigest: d('a'),
      now: new Date('2026-07-18T00:00:00.001Z'),
    })).rejects.toMatchObject({ code: 'E2E_RUNTIME_CAPABILITY_PROOF_STALE' })
  })

  test('fresh install-browser 显式 bootstrap capability proof，bootstrap 失败不写 proof', async () => {
    for (const shouldFail of [false, true]) {
      const roots = await createRuntimeTestRoots()
      const output = capture()
      const installation = {
        version: '0.0.0', protocolMajor: 1 as const, versionRoot: '/runtime', entrypoint: '/runtime/repo-e2e.js',
        installationDigest: d('a'), sourceRepositoryIndependent: true as const,
      }
      const exitCode = await runCli(
        ['install-browser'], Readable.from([]), output.stream, capture().stream,
        {
          homeDir: roots.home,
          installRuntime: async () => { throw new Error('unused') },
          uninstallRuntime: async () => { throw new Error('unused') },
          inspectRuntimeInstallation: async () => installation,
          installChromium: async () => ({ installed: true }),
          bootstrapBrowserRuntime: async () => {
            if (shouldFail) throw new Error('bootstrap canary failed')
            const store = await RuntimeRunStore.open({ homeDir: roots.home, projectRoot: roots.project })
            await store.close()
            await recordRuntimeCapabilityProof(proofInput(roots.home))
          },
        },
      )
      expect(exitCode === 0).toBe(!shouldFail)
      if (shouldFail) {
        await expect(inspectRuntimeCapabilityProof({
          homeDir: roots.home, runtimeInstallationDigest: d('a'),
        })).rejects.toMatchObject({ code: 'E2E_RUNTIME_CAPABILITY_PROOF_NOT_INSTALLED' })
      } else {
        await expect(inspectRuntimeCapabilityProof({
          homeDir: roots.home, runtimeInstallationDigest: d('a'),
        })).resolves.toMatchObject({ runtimeInstallationDigest: d('a') })
      }
    }
  })

  test('install-browser stdout is one canonical JSON document without absolute installation paths', async () => {
    const roots = await createRuntimeTestRoots()
    const output = capture()
    const installation = {
      version: '0.0.0', protocolMajor: 1 as const, versionRoot: '/private/runtime/version',
      entrypoint: '/private/runtime/version/repo-e2e.js', installationDigest: d('a'),
      sourceRepositoryIndependent: true as const,
    }
    const browser = {
      root: '/private/runtime/browser-root', executablePath: '/private/runtime/browser-root/chrome',
      manifest: {
        schemaVersion: '1.0.0', runtimeVersion: '0.0.0', runtimeInstallationDigest: d('a'),
        playwrightVersion: '1.61.1', platform: process.platform, arch: process.arch,
        revision: '1234', chromiumVersion: 'Chromium 123', cliByteLength: 1, cliDigest: d('b'),
        executableRelativePath: 'chromium-1234/chrome', executableByteLength: 1,
        executableDigest: d('c'), files: [], closureDigest: d('d'),
      },
    }
    const exitCode = await runCli(
      ['install-browser'], Readable.from([]), output.stream, capture().stream,
      {
        homeDir: roots.home,
        installRuntime: async () => { throw new Error('unused') },
        uninstallRuntime: async () => { throw new Error('unused') },
        inspectRuntimeInstallation: async () => installation,
        installChromium: async () => browser,
        bootstrapBrowserRuntime: async () => undefined,
      },
    )

    expect(exitCode).toBe(0)
    expect(output.text().trim().split('\n')).toHaveLength(1)
    expect(JSON.parse(output.text())).toEqual({
      ok: true,
      result: {
        installed: true, runtimeVersion: '0.0.0', runtimeInstallationDigest: d('a'),
        playwrightVersion: '1.61.1', chromiumRevision: '1234', browserClosureDigest: d('d'),
        browserExecutableDigest: d('c'),
      },
    })
    expect(output.text()).not.toContain('/private/')
  })
})

function proofInput(homeDir: string) {
  return {
    homeDir, runtimeInstallationDigest: d('a'),
    gateway: { sessionMeasurementDigest: d('b'), policyDigest: d('c'), auditDigest: d('d') },
    isolation: {
      browserMeasurementDigest: d('e'), sandboxProfileDigest: d('1'), canaryProofDigest: d('2'),
      browserClosureDigest: d('3'), browserExecutableDigest: d('4'),
    },
    verifiedAt: '2026-07-17T00:00:00.000Z',
  }
}

function capture() {
  const chunks: Buffer[] = []
  return {
    stream: new Writable({ write(chunk, _encoding, callback) { chunks.push(Buffer.from(chunk)); callback() } }),
    text: () => Buffer.concat(chunks).toString('utf8'),
  }
}
