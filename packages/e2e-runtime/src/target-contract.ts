import {
  TargetContractSchema,
  canonicalizeJson,
  digestText,
  E2EError,
  type TargetContract,
} from '@mutil-skills/e2e-contracts'
import { z } from 'zod'

const DigestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/)

export const TargetContractFactSchema = z.object({
  schemaVersion: z.literal('1.0.0'),
  contract: TargetContractSchema,
  contractDigest: DigestSchema,
  environmentIdentityDigest: DigestSchema,
}).strict()

export type TargetContractFact = z.infer<typeof TargetContractFactSchema>

export function createTargetContractFact(input: TargetContract): TargetContractFact {
  const contract = TargetContractSchema.parse(input)
  return TargetContractFactSchema.parse({
    schemaVersion: '1.0.0',
    contract,
    contractDigest: digestText('e2e-target-contract/v1', canonicalizeJson(contract)),
    environmentIdentityDigest: digestText('e2e-target-environment/v1', canonicalizeJson({
      baseOrigin: contract.baseOrigin,
      environmentLabel: contract.environmentLabel,
    })),
  })
}

export function assertTargetEnvironmentConsistency(
  factInput: unknown,
  environment: { baseOrigin: string; environmentLabel: string },
): TargetContractFact {
  const fact = TargetContractFactSchema.parse(factInput)
  const expected = digestText('e2e-target-environment/v1', canonicalizeJson(environment))
  if (fact.environmentIdentityDigest !== expected
    || fact.contract.baseOrigin !== environment.baseOrigin
    || fact.contract.environmentLabel !== environment.environmentLabel) {
    throw targetError('E2E_TARGET_ENVIRONMENT_MISMATCH')
  }
  return fact
}

function targetError(code: string): E2EError {
  return new E2EError({ code, category: 'safety', message: code, retryable: false })
}
