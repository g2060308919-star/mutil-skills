import { readFile } from 'node:fs/promises'
import { expect, test } from 'vitest'
import * as runtimePublicApi from '../src/index.js'

test('public Runtime package exposes the safe facade, status model, and protocol schemas', async () => {
  expect(Object.keys(runtimePublicApi).sort()).toEqual([
    'AcceptanceReviewReceiptSchema',
    'E2EFacade',
    'E2EFacadeError',
    'E2EInputDraftSchema',
    'E2EInputPreparer',
    'RUNTIME_PACKAGE_VERSION',
    'RunStatusPublisher',
    'RuntimeCompatibilityDescriptorV1Schema',
    'RuntimeDoctorProbeSchema',
    'RuntimeDoctorReportSchema',
    'RuntimeErrorSchema',
    'RuntimeRequestEnvelopeSchema',
    'RuntimeResolverPolicySchema',
    'RuntimeResponseEnvelopeSchema',
    'TargetContractFactSchema',
    'TargetProbeFactSchema',
    'TaskStateViewV1Schema',
    'assertRunHandle',
    'assertTargetEnvironmentConsistency',
    'authorizeTargetProbe',
    'buildAcceptanceReview',
    'classifyRunCondition',
    'confirmAcceptanceReview',
    'createRunHandle',
    'createTargetContractFact',
    'describeRuntimeCompatibility',
    'projectRunStage',
    'resolveRuntimeInstallation',
    'runTargetProbe',
    'withResolvedRuntimeInstallation',
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
