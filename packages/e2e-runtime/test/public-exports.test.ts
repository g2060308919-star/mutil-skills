import { readFile } from 'node:fs/promises'
import { expect, test } from 'vitest'
import * as runtimePublicApi from '../src/index.js'

test('public Runtime package exposes only protocol schemas and version metadata', async () => {
  expect(Object.keys(runtimePublicApi).sort()).toEqual([
    'RUNTIME_PACKAGE_VERSION',
    'RuntimeDoctorProbeSchema',
    'RuntimeDoctorReportSchema',
    'RuntimeErrorSchema',
    'RuntimeRequestEnvelopeSchema',
    'RuntimeResponseEnvelopeSchema',
  ])
  for (const forbidden of [
    'E2ERuntimeHost', 'RuntimeAuthorityHost', 'RuntimeRunStore', 'startRuntimeAuthorityHost',
    'installRuntime', 'uninstallRuntime', 'inspectRuntimeInstallation', 'resolveProjectIdentity',
    'RuntimeSecretBroker', 'createSystemSecretProvider', 'SecretProvider', 'OneTimeSecretHandle',
  ]) {
    expect(runtimePublicApi).not.toHaveProperty(forbidden)
  }

  const packageJson = JSON.parse(await readFile('packages/e2e-runtime/package.json', 'utf8')) as Record<string, any>
  expect(packageJson.exports).toEqual({
    '.': { types: './dist/src/index.d.ts', import: './dist/src/index.js' },
  })
})
