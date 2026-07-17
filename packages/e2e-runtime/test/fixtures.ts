import { mkdtemp, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer, type Server } from 'node:http'
import type {
  GatewayProxyProcessHandle,
  GatewayProxyStartOptions,
  GatewayWriteLifecycle,
} from '../src/gateway-proxy-host.js'
import { startGatewayProxyHostWithTestControl } from '../src/gateway-proxy-host.js'

export async function createRuntimeTestRoots(): Promise<{
  root: string
  home: string
  project: string
  source: string
}> {
  const root = await mkdtemp(join(tmpdir(), 'mutil-e2e-runtime-'))
  const home = join(root, 'home')
  const project = join(root, 'project')
  const source = join(root, 'source')
  await Promise.all([
    mkdir(home, { recursive: true }),
    mkdir(project, { recursive: true }),
    mkdir(source, { recursive: true }),
  ])
  return { root, home, project, source }
}

/** 让受限执行环境的 loopback EPERM 立即作为明确环境错误返回，而不是测试超时。 */
export async function listenOnLoopback(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => reject(error)
    server.once('error', onError)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', onError)
      resolve()
    })
  })
}

export async function canBindLoopback(): Promise<boolean> {
  const server = createServer()
  try {
    await listenOnLoopback(server)
    return true
  } catch (error) {
    if (isSystemError(error) && ['EACCES', 'EPERM'].includes(error.code)) return false
    throw error
  } finally {
    if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()))
  }
}

function isSystemError(value: unknown): value is NodeJS.ErrnoException & { code: string } {
  return value instanceof Error && typeof (value as NodeJS.ErrnoException).code === 'string'
}

export interface GatewayProxyTestHandle extends GatewayProxyProcessHandle, GatewayWriteLifecycle {
  requestThroughProxy(
    url: string,
    correlation: { actionId: string; capabilityId: string; channel?: 'http' | 'beacon' | 'service-worker' },
    caCertPathOverride?: string,
  ): Promise<{ status: number; body: string; headers: Record<string, string | string[]> }>
  openWebSocketThroughProxy(
    url: string,
    correlation: { actionId: string; capabilityId: string; authorized?: boolean },
  ): Promise<{ status: number; responseHead: string }>
  requestWithTokenHeaders(
    url: string,
    correlation: { actionId: string; capabilityId: string },
    tokenValues: string[],
  ): Promise<{ status: number; body: string }>
}

export async function startGatewayProxyHostForTest(
  options: Omit<GatewayProxyStartOptions, 'authorityRoot'> & { authorityRoot?: string },
): Promise<GatewayProxyTestHandle> {
  const roots = options.authorityRoot === undefined ? await createRuntimeTestRoots() : undefined
  const authorityRoot = options.authorityRoot ?? join(roots!.home, '.mutil-skills', 'e2e', 'authority')
  await mkdir(authorityRoot, { recursive: true, mode: 0o700 })
  const started = await startGatewayProxyHostWithTestControl({ ...options, authorityRoot })
  return Object.assign(started.handle, {
    requestThroughProxy: started.requestThroughProxy,
    openWebSocketThroughProxy: started.openWebSocketThroughProxy,
    requestWithTokenHeaders: started.requestWithTokenHeaders,
    finalizeWriteOutcome: started.writeLifecycle.finalizeWriteOutcome,
    markUnknown: started.writeLifecycle.markUnknown,
  })
}
