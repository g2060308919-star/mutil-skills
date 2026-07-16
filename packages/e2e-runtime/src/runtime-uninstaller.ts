import { lstat, realpath, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { runtimeLayout } from './runtime-layout.js'
import { withRuntimeInstallLock, writeActiveRuntimeFiles } from './runtime-installer.js'
import {
  assertExactRuntimeVersion,
  readRuntimeCurrent,
  runtimeError,
  verifyInstalledRuntimeVersion,
  verifyRuntimeRoot,
} from './runtime-manifest.js'

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
    const target = await verifyInstalledRuntimeVersion(layout, options.version)
    const current = await readRuntimeCurrent(layout)
    let activeVersion: string | undefined
    if (current.runtimeVersion === options.version) {
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
