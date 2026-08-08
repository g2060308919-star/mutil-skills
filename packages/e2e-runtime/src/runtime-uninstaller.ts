import { lstat, realpath, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { runtimeLayout } from './runtime-layout.js'
import { withRuntimeInstallLock, writeActiveRuntimeFiles } from './runtime-installer.js'
import {
  assertExactRuntimeVersion,
  runtimeError,
  verifyCurrentRuntimeInstallation,
  verifyInstalledRuntimeVersion,
  verifyRuntimeRoot,
} from './runtime-manifest.js'
import { RuntimeRunStore } from './run-store.js'

export interface UninstallRuntimeOptions {
  homeDir: string
  version: string
  activateVersion?: string
}

export interface RuntimeUninstallResult {
  version: string
  activeVersion?: string
}

export async function uninstallRuntime(options: UninstallRuntimeOptions): Promise<RuntimeUninstallResult> {
  assertExactRuntimeVersion(options.version)
  if (options.activateVersion !== undefined) assertExactRuntimeVersion(options.activateVersion)
  if (options.activateVersion === options.version) {
    runtimeError('E2E_RUNTIME_REPLACEMENT_NOT_VERIFIED', 'replacement 不能与待卸载版本相同', 'input')
  }
  const layout = runtimeLayout(options.homeDir)
  await verifyRuntimeRoot(layout)
  return withRuntimeInstallLock(layout, async () => {
    await verifyRuntimeRoot(layout)
    const active = await verifyCurrentRuntimeInstallation(layout)
    const target = active.installation.version === options.version
      ? active.installation
      : await verifyInstalledRuntimeVersion(layout, options.version)
    const runStore = await RuntimeRunStore.open({ homeDir: options.homeDir })
    try {
      const references = await runStore.listActiveRuntimeInstallationReferences()
      const referencedBy = references.filter((reference) =>
        reference.installationDigest === target.manifest.installationDigest)
      if (referencedBy.length > 0) runtimeError(
        'E2E_RUNTIME_VERSION_REFERENCED_BY_ACTIVE_RUN',
        `Runtime ${options.version} 仍被 ${referencedBy.length} 个活跃 Run 精确绑定`,
      )
    } finally {
      await runStore.close()
    }
    let activeVersion: string | undefined
    if (active.installation.version === options.version) {
      if (options.activateVersion === undefined) {
        runtimeError('E2E_RUNTIME_ACTIVE_VERSION_REMOVAL_BLOCKED', 'active Runtime 必须先显式验证 replacement')
      }
      let replacement
      try {
        replacement = await verifyInstalledRuntimeVersion(layout, options.activateVersion)
      } catch (error) {
        if (error instanceof Error) {
          runtimeError('E2E_RUNTIME_REPLACEMENT_NOT_VERIFIED', 'replacement Runtime 未安装或未通过完整验证')
        }
        throw error
      }
      await writeActiveRuntimeFiles(layout, replacement)
      activeVersion = replacement.version
    } else if (options.activateVersion !== undefined) {
      runtimeError('E2E_RUNTIME_REPLACEMENT_NOT_VERIFIED', '只有卸载 active Runtime 时才能指定 replacement', 'input')
    }

    const targetPath = join(layout.versions, options.version)
    const metadata = await lstat(targetPath)
    if (!metadata.isDirectory() || metadata.isSymbolicLink() || target.versionRoot !== await realpath(targetPath)) {
      runtimeError('E2E_RUNTIME_VERSION_PATH_UNSAFE', '卸载目标不再是已验证 version root')
    }
    await rm(targetPath, { recursive: true, force: false })
    return {
      version: options.version,
      ...(activeVersion === undefined ? {} : { activeVersion }),
    }
  })
}
