import { join } from 'node:path'
import { runtimeLayout } from './runtime-layout.js'
import {
  RUNTIME_ENTRYPOINT,
  readRuntimeCurrent,
  runtimeError,
  verifyInstalledRuntimeVersion,
  verifyRuntimeRoot,
} from './runtime-manifest.js'

export interface RuntimeInstallation {
  version: string
  protocolMajor: 1
  versionRoot: string
  entrypoint: string
  installationDigest: string
  sourceRepositoryIndependent: true
}

export interface InspectRuntimeInstallationOptions {
  homeDir: string
}

export async function inspectRuntimeInstallation(
  options: InspectRuntimeInstallationOptions,
): Promise<RuntimeInstallation> {
  const layout = runtimeLayout(options.homeDir)
  await verifyRuntimeRoot(layout)
  const current = await readRuntimeCurrent(layout)
  const verified = await verifyInstalledRuntimeVersion(layout, current.runtimeVersion)
  if (verified.versionRoot !== current.versionRoot
    || verified.manifest.installationDigest !== current.runtimeManifestDigest
    || verified.entrypoint !== join(verified.versionRoot, ...RUNTIME_ENTRYPOINT.split('/'))) {
    runtimeError('E2E_RUNTIME_CURRENT_MISMATCH', 'current pointer 未绑定已验证 installation')
  }
  return {
    version: verified.version,
    protocolMajor: 1,
    versionRoot: verified.versionRoot,
    entrypoint: verified.entrypoint,
    installationDigest: verified.manifest.installationDigest,
    sourceRepositoryIndependent: true,
  }
}
