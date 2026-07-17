export const GATEWAY_MAX_REQUEST_BODY_BYTES = 1024 * 1024

export function projectedBodyMatches(input: {
  headers: Record<string, string | string[] | undefined>
  expectedBodyBase64Url?: string
  actualBody: Buffer
}): boolean {
  if (input.headers['transfer-encoding'] !== undefined) return false
  const expected = input.expectedBodyBase64Url === undefined
    ? Buffer.alloc(0) : Buffer.from(input.expectedBodyBase64Url, 'base64url')
  try {
    if (expected.byteLength > GATEWAY_MAX_REQUEST_BODY_BYTES) return false
    const rawLength = input.headers['content-length']
    if (Array.isArray(rawLength)) return false
    if (rawLength !== undefined) {
      if (!/^(0|[1-9]\d{0,9})$/.test(rawLength)) return false
      const declared = Number(rawLength)
      if (declared > GATEWAY_MAX_REQUEST_BODY_BYTES || declared !== expected.byteLength) return false
    } else if (expected.byteLength > 0) return false
    return input.actualBody.byteLength === expected.byteLength && input.actualBody.equals(expected)
  } finally { expected.fill(0) }
}
