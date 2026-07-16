import { E2EError, canonicalizeJson } from '@mutil-skills/e2e-contracts'
import type { Readable, Writable } from 'node:stream'
import { exitCodeForResponse, parseRuntimeRequest, runtimeErrorResponse } from './protocol.js'

const SAFE_ID = /^[A-Za-z0-9._:-]{1,256}$/

export async function runCli(
  arguments_: string[],
  stdin: Readable,
  stdout: Writable,
  stderr: Writable,
): Promise<number> {
  void stderr

  if (arguments_.length === 1 && arguments_[0] === '--version') {
    await writeText(stdout, '0.0.0\n')
    return 0
  }

  if (arguments_.length !== 1 || arguments_[0] !== 'rpc') {
    return writeErrorResponse(stdout, 'UNKNOWN', new E2EError({
      code: 'E2E_RUNTIME_REQUEST_INVALID',
      category: 'input',
      message: '只支持 --version 或 rpc',
      retryable: false,
    }))
  }

  const json = await readUtf8(stdin)
  try {
    const request = parseRuntimeRequest(json)
    return writeErrorResponse(stdout, request.requestId, new E2EError({
      code: 'E2E_RUNTIME_NOT_INSTALLED',
      category: 'environment',
      message: 'E2E Runtime Host 尚未安装',
      retryable: false,
    }))
  } catch (error) {
    const runtimeError = error instanceof E2EError
      ? error
      : new E2EError({
          code: 'E2E_RUNTIME_INTERNAL_ERROR',
          category: 'internal',
          message: 'Runtime 处理请求时发生内部错误',
          retryable: false,
          cause: error,
        })
    return writeErrorResponse(stdout, requestIdFromUntrustedJson(json), runtimeError)
  }
}

async function writeErrorResponse(stdout: Writable, requestId: string, error: E2EError): Promise<number> {
  const response = runtimeErrorResponse(requestId, error)
  await writeText(stdout, `${canonicalizeJson(response)}\n`)
  return exitCodeForResponse(response)
}

async function readUtf8(stream: Readable): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of stream) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  return Buffer.concat(chunks).toString('utf8')
}

async function writeText(stream: Writable, text: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    stream.write(text, (error) => error ? reject(error) : resolve())
  })
}

function requestIdFromUntrustedJson(json: string): string {
  try {
    const value = JSON.parse(json) as unknown
    if (isRecord(value) && typeof value.requestId === 'string' && SAFE_ID.test(value.requestId)) {
      return value.requestId
    }
  } catch {
    // The response still needs a schema-valid correlation value for malformed JSON.
  }
  return 'UNKNOWN'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
