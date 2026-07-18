import { E2EError } from '@mutil-skills/e2e-contracts'
import type {
  RuntimeOwnedResourceRecord,
  RuntimeOwnedResourceRegistry,
} from './runtime-owned-resource-registry.js'
import type {
  RuntimeRecoveryCoordinator,
  RuntimeRecoveryResult,
} from './runtime-recovery.js'

type RecoveryInput = {
  projectIdentityDigest: string
  runId: string
  attemptId: string
}

type OwnedResourceRegistration = Omit<RuntimeOwnedResourceRecord,
  'revision' | 'status' | 'cleanupReceiptDigest'>

interface RuntimeWriteProductionBackend {
  recovery: Pick<RuntimeRecoveryCoordinator, 'recover'>
  ownedResources: Pick<RuntimeOwnedResourceRegistry, 'register'>
}

declare const runtimeWriteProductionCapabilityBrand: unique symbol

/**
 * 生产写链唯一可注入 Host 的能力。
 *
 * 能力对象本身没有可调用字段，真实 backend 只保存在本进程 WeakMap 中；调用方不能用
 * 普通对象伪造恢复器，也不能只装配恢复而漏掉 owned-resource registry。
 */
export interface RuntimeWriteProductionCapability {
  readonly [runtimeWriteProductionCapabilityBrand]: true
}

const productionCapabilities = new WeakMap<object, RuntimeWriteProductionBackend>()

/**
 * 生产装配层必须同时提供恢复协调器和持久化资源登记表，缺少任一项都不能签发能力。
 * 当前仓库尚无生产写执行链；后续写链创建 loopback endpoint、browser profile lock 或
 * install staging 前，必须先调用 registerRuntimeWriteOwnedResource 登记 owner marker。
 */
export function authorizeRuntimeWriteProduction(
  backend: RuntimeWriteProductionBackend,
): RuntimeWriteProductionCapability {
  if (typeof backend.recovery?.recover !== 'function'
    || typeof backend.ownedResources?.register !== 'function') {
    throw productionCapabilityError('E2E_RUNTIME_WRITE_PRODUCTION_WIRING_INVALID')
  }
  const capability = Object.freeze({}) as RuntimeWriteProductionCapability
  productionCapabilities.set(capability, backend)
  return capability
}

/** 在外部资源创建前持久化其精确 owner/descriptor；重复登记必须完全相同。 */
export async function registerRuntimeWriteOwnedResource(
  capability: RuntimeWriteProductionCapability,
  registration: OwnedResourceRegistration,
): Promise<RuntimeOwnedResourceRecord> {
  const backend = requireBackend(capability)
  return await backend.ownedResources.register(structuredClone(registration))
}

/**
 * 所有生产写外部资源的唯一创建入口：先把 owner marker/descriptor 持久化成功，
 * 再调用实际创建函数。创建失败时保留 active record，交给 crash recovery 精确检查和清理。
 */
export async function createRegisteredRuntimeWriteOwnedResource<T>(
  capability: RuntimeWriteProductionCapability,
  registration: OwnedResourceRegistration,
  create: (registered: RuntimeOwnedResourceRecord) => Promise<T>,
): Promise<T> {
  if (typeof create !== 'function') throw productionCapabilityError(
    'E2E_RUNTIME_WRITE_RESOURCE_FACTORY_INVALID',
  )
  const registered = await registerRuntimeWriteOwnedResource(capability, registration)
  return await create(structuredClone(registered))
}

/** Host 的 write recovery 只能经由已签发的完整生产能力调用。 */
export async function recoverRuntimeProductionWrite(
  capability: RuntimeWriteProductionCapability,
  input: RecoveryInput,
): Promise<RuntimeRecoveryResult> {
  const backend = requireBackend(capability)
  return await backend.recovery.recover(structuredClone(input))
}

function requireBackend(capability: RuntimeWriteProductionCapability): RuntimeWriteProductionBackend {
  const backend = productionCapabilities.get(capability)
  if (backend === undefined) throw productionCapabilityError(
    'E2E_RUNTIME_WRITE_PRODUCTION_CAPABILITY_INVALID',
  )
  return backend
}

function productionCapabilityError(code: string): E2EError {
  return new E2EError({
    code,
    category: 'safety',
    message: '生产写能力未由 Runtime 受信装配层签发或装配不完整',
    retryable: false,
  })
}
