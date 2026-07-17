import { isAbsolute } from 'node:path'
import type { ApproverIdentity } from '@mutil-skills/e2e-contracts'
import type { SqliteStateDirectoryIdentity } from './sqlite-state-store.js'

export interface AuthorityExecutionHostConfig {
  rpc: { issuer: string; keyId: string; clientId: string }
  approval: {
    issuer: string
    keyId: string
    statePath: string
    stateEncryptionKeyBase64Url: string
    testWorkspaceRoots: string[]
    expectedStateDirectory?: SqliteStateDirectoryIdentity
    approvalIdentities?: ApproverIdentity[]
    manualIdentities?: ApproverIdentity[]
  }
  lease: {
    statePath: string
    testWorkspaceRoots: string[]
    expectedStateDirectory?: SqliteStateDirectoryIdentity
  }
  userPresence?: {
    installationDigest: string
    ttlMs: number
    assets: {
      indexHtmlBase64Url: string
      approvalJavaScriptBase64Url: string
      simpleWebAuthnBrowserBase64Url: string
    }
  }
  clock: { kind: 'system' } | { kind: 'fixed-test-only'; now: string }
  sessionKeyBase64Url: string
}

const SAFE_ID = /^[A-Za-z0-9._:-]{1,256}$/
const DIGEST = /^sha256:[a-f0-9]{64}$/

export function parseAuthorityExecutionHostConfig(value: unknown): AuthorityExecutionHostConfig {
  if (!isRecord(value)) invalid()
  requireKeys(value, ['approval', 'clock', 'lease', 'rpc', 'sessionKeyBase64Url'], ['userPresence'])
  if (!isRecord(value.rpc)) invalid()
  requireKeys(value.rpc, ['clientId', 'issuer', 'keyId'])
  if (![value.rpc.issuer, value.rpc.keyId, value.rpc.clientId].every((item) =>
    typeof item === 'string' && SAFE_ID.test(item))) invalid()
  const approval = parseApprovalConfig(value.approval)
  const lease = parseLeaseConfig(value.lease)
  const clock = parseClock(value.clock)
  const sessionKeyBase64Url = parseCanonicalKey(value.sessionKeyBase64Url)
  const userPresence = value.userPresence === undefined ? undefined : parseUserPresence(value.userPresence)
  return structuredClone({
    rpc: value.rpc,
    approval,
    lease,
    ...(userPresence === undefined ? {} : { userPresence }),
    clock,
    sessionKeyBase64Url,
  }) as AuthorityExecutionHostConfig
}

function parseApprovalConfig(value: unknown): AuthorityExecutionHostConfig['approval'] {
  if (!isRecord(value)) invalid()
  requireKeys(value, [
    'issuer', 'keyId', 'stateEncryptionKeyBase64Url', 'statePath', 'testWorkspaceRoots',
  ], ['approvalIdentities', 'expectedStateDirectory', 'manualIdentities'])
  if (typeof value.issuer !== 'string' || !SAFE_ID.test(value.issuer)
    || typeof value.keyId !== 'string' || !SAFE_ID.test(value.keyId)) invalid()
  return {
    issuer: value.issuer,
    keyId: value.keyId,
    statePath: parseStatePath(value.statePath, value.expectedStateDirectory),
    stateEncryptionKeyBase64Url: parseCanonicalKey(value.stateEncryptionKeyBase64Url),
    testWorkspaceRoots: parseRoots(value.testWorkspaceRoots),
    ...(value.expectedStateDirectory === undefined ? {} : {
      expectedStateDirectory: parseDirectoryIdentity(value.expectedStateDirectory),
    }),
    ...(value.approvalIdentities === undefined ? {} : {
      approvalIdentities: parseIdentities(value.approvalIdentities),
    }),
    ...(value.manualIdentities === undefined ? {} : {
      manualIdentities: parseIdentities(value.manualIdentities),
    }),
  }
}

function parseLeaseConfig(value: unknown): AuthorityExecutionHostConfig['lease'] {
  if (!isRecord(value)) invalid()
  requireKeys(value, ['statePath', 'testWorkspaceRoots'], ['expectedStateDirectory'])
  return {
    statePath: parseStatePath(value.statePath, value.expectedStateDirectory),
    testWorkspaceRoots: parseRoots(value.testWorkspaceRoots),
    ...(value.expectedStateDirectory === undefined ? {} : {
      expectedStateDirectory: parseDirectoryIdentity(value.expectedStateDirectory),
    }),
  }
}

function parseUserPresence(value: unknown): NonNullable<AuthorityExecutionHostConfig['userPresence']> {
  if (!isRecord(value)) invalid()
  requireKeys(value, ['assets', 'installationDigest', 'ttlMs'])
  if (typeof value.installationDigest !== 'string' || !DIGEST.test(value.installationDigest)
    || typeof value.ttlMs !== 'number' || !Number.isSafeInteger(value.ttlMs)
    || value.ttlMs < 1 || value.ttlMs > 5 * 60 * 1000 || !isRecord(value.assets)) invalid()
  requireKeys(value.assets, [
    'approvalJavaScriptBase64Url', 'indexHtmlBase64Url', 'simpleWebAuthnBrowserBase64Url',
  ])
  return {
    installationDigest: value.installationDigest,
    ttlMs: value.ttlMs,
    assets: {
      indexHtmlBase64Url: parseCanonicalBytes(value.assets.indexHtmlBase64Url, 256 * 1024),
      approvalJavaScriptBase64Url: parseCanonicalBytes(value.assets.approvalJavaScriptBase64Url, 256 * 1024),
      simpleWebAuthnBrowserBase64Url:
        parseCanonicalBytes(value.assets.simpleWebAuthnBrowserBase64Url, 2 * 1024 * 1024),
    },
  }
}

function parseClock(value: unknown): AuthorityExecutionHostConfig['clock'] {
  if (!isRecord(value) || (value.kind !== 'system' && value.kind !== 'fixed-test-only')) invalid()
  if (value.kind === 'system') {
    requireKeys(value, ['kind'])
    return { kind: 'system' }
  }
  requireKeys(value, ['kind', 'now'])
  if (typeof value.now !== 'string' || !Number.isFinite(Date.parse(value.now))
    || new Date(value.now).toISOString() !== value.now) invalid()
  return { kind: 'fixed-test-only', now: value.now }
}

function parseDirectoryIdentity(value: unknown): SqliteStateDirectoryIdentity {
  if (!isRecord(value)) invalid()
  requireKeys(value, ['device', 'inode', 'realPath'])
  if (typeof value.realPath !== 'string' || !isAbsolute(value.realPath)
    || typeof value.device !== 'string' || !/^[0-9]+$/.test(value.device)
    || typeof value.inode !== 'string' || !/^[0-9]+$/.test(value.inode)) invalid()
  return { realPath: value.realPath, device: value.device, inode: value.inode }
}

function parseIdentities(value: unknown): ApproverIdentity[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 1_000) invalid()
  const identities = value.map((identity) => {
    if (!isRecord(identity)) invalid()
    requireKeys(identity, ['roles', 'subject'])
    if (typeof identity.subject !== 'string' || !SAFE_ID.test(identity.subject)
      || !Array.isArray(identity.roles) || identity.roles.length === 0
      || identity.roles.some((role) => typeof role !== 'string' || !SAFE_ID.test(role))
      || new Set(identity.roles).size !== identity.roles.length) invalid()
    return { subject: identity.subject, roles: [...identity.roles] } as ApproverIdentity
  })
  if (new Set(identities.map((identity) => identity.subject)).size !== identities.length) invalid()
  return identities
}

function parseRoots(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 1_000
    || value.some((root) => typeof root !== 'string' || !isAbsolute(root))
    || new Set(value).size !== value.length) invalid()
  return [...value] as string[]
}

function parseStatePath(value: unknown, identity: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 8 * 1024 || value.includes('\0')) invalid()
  if (identity === undefined) {
    if (!isAbsolute(value)) invalid()
  } else if (!/^[A-Za-z0-9._-]{1,256}$/.test(value) || value === '.' || value === '..') invalid()
  return value
}

function parseCanonicalKey(value: unknown): string {
  if (typeof value !== 'string') invalid()
  const bytes = Buffer.from(value, 'base64url')
  try {
    if (bytes.byteLength !== 32 || bytes.toString('base64url') !== value) invalid()
    return value
  } finally {
    bytes.fill(0)
  }
}

function parseCanonicalBytes(value: unknown, maximum: number): string {
  if (typeof value !== 'string') invalid()
  const bytes = Buffer.from(value, 'base64url')
  if (bytes.byteLength === 0 || bytes.byteLength > maximum || bytes.toString('base64url') !== value) invalid()
  return value
}

function requireKeys(value: Record<string, unknown>, required: string[], optional: string[] = []): void {
  const actual = Object.keys(value).sort()
  const allowed = [...required, ...optional]
  if (required.some((key) => !(key in value)) || actual.some((key) => !allowed.includes(key))) invalid()
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function invalid(): never {
  throw Object.assign(new Error('E2E_RPC_HOST_CONFIG_INVALID'), { code: 'E2E_RPC_HOST_CONFIG_INVALID' })
}
