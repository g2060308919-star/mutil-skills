import { existsSync } from 'node:fs'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, expect, test } from 'vitest'
import { bootstrapInstalledBrowserRuntime } from '../packages/e2e-runtime/src/runtime-browser-wiring.js'
import { inspectRuntimeCapabilityProof } from '../packages/e2e-runtime/src/runtime-capability-proof.js'
import { openRuntimeArtifactStoreAuthority } from '../packages/e2e-runtime/src/authority-host.js'
import { inspectSystemChrome } from '../packages/e2e-runtime/src/system-chrome.js'

const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const executablePath = process.env.E2E_RUNTIME_SYSTEM_CHROME_EXECUTABLE
  ?? (process.platform === 'darwin'
    ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
    : '/usr/bin/google-chrome-stable')
const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true })))
})

test.runIf(existsSync(executablePath))(
  '系统 Chrome 完成受控 canary、隔离 Profile cleanup 与 capability proof',
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'mutil-e2e-system-chrome-'))
    roots.push(root)
    const homeDir = join(root, 'home')
    const projectRoot = join(root, 'project')
    await Promise.all([
      mkdir(homeDir, { mode: 0o700 }),
      mkdir(projectRoot, { mode: 0o700 }),
    ])
    const installation = {
      version: '0.2.0',
      protocolMajor: 1 as const,
      versionRoot: sourceRoot,
      entrypoint: join(sourceRoot, 'packages', 'e2e-runtime', 'src', 'runtime-bin.ts'),
      installationDigest: `sha256:${'a'.repeat(64)}`,
      sourceRepositoryIndependent: true as const,
    }
    const browserInstallation = await inspectSystemChrome({
      executablePath,
      projectRoot,
      runtimeInstallationDigest: installation.installationDigest,
      controlledLaunchProofDigest: `sha256:${'0'.repeat(64)}`,
      configuredAt: '2026-07-19T00:00:00.000Z',
    })

    await bootstrapInstalledBrowserRuntime({
      homeDir,
      installation,
      browserInstallation,
      prepareAuthorityRoot: async () => {
        const authority = await openRuntimeArtifactStoreAuthority({
          homeDir, installation, subject: `local:uid:${process.getuid!()}`,
        })
        await authority.close()
      },
    })

    await expect(inspectRuntimeCapabilityProof({
      homeDir, runtimeInstallationDigest: installation.installationDigest,
    })).resolves.toMatchObject({
      runtimeInstallationDigest: installation.installationDigest,
      isolation: {
        browserExecutableDigest: browserInstallation.selection.executableDigest,
      },
    })
    expect(existsSync(join(homeDir, '.mutil-skills', 'runtime', 'e2e', 'browsers'))).toBe(false)
  },
  60_000,
)
