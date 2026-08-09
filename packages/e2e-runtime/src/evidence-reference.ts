const SUPPORTED_EVIDENCE_AUTHORITIES: Readonly<Record<string, ReadonlySet<string>>> = {
  'runtime-artifact:': new Set(['full-playwright-traces', 'b2b']),
  'artifact:': new Set(['generation']),
  'quarantine:': new Set(['evidence']),
}

/**
 * Runtime 持久证据只允许引用受控产物域，禁止网络、宿主文件和带凭据的 URI。
 */
export function isRuntimeEvidenceUri(value: unknown): value is string {
  if (typeof value !== 'string' || value.length < 1 || value.length > 16_384) return false
  if (value.includes('\\') || value.includes('%') || /\/(?:\.{1,2})(?:\/|$)/.test(value)) return false
  try {
    const uri = new URL(value)
    const authorities = SUPPORTED_EVIDENCE_AUTHORITIES[uri.protocol]
    const segments = uri.pathname.split('/').slice(1)
    return authorities !== undefined && authorities.has(uri.hostname)
      && uri.username === '' && uri.password === '' && uri.hash === ''
      && uri.port === '' && uri.search === ''
      && segments.length > 0 && segments.every((segment) => /^[A-Za-z0-9._:-]{1,256}$/.test(segment))
  } catch {
    return false
  }
}
