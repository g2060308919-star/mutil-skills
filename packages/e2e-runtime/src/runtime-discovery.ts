import { runtimeLayout } from './runtime-layout.js'
import {
  verifyCurrentRuntimeInstallation,
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
  const { installation: verified } = await verifyCurrentRuntimeInstallation(layout)
  return {
    version: verified.version,
    protocolMajor: 1,
    versionRoot: verified.versionRoot,
    entrypoint: verified.entrypoint,
    installationDigest: verified.manifest.installationDigest,
    sourceRepositoryIndependent: true,
  }
}
