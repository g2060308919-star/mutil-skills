import {
  PageIdentityPolicySchema,
  type PageIdentityPolicy,
  type PageIdentitySignal,
} from '@mutil-skills/e2e-contracts'

export interface PageIdentityQuery {
  currentUrl(): string | Promise<string>
  evaluateSignal(signal: PageIdentitySignal): Promise<{ matched: boolean; actual: string }>
}

export interface PageIdentitySignalEvaluation {
  kind: PageIdentitySignal['kind']
  expected: string
  actual: string
  matched: boolean
}

export interface PageIdentityEvaluation {
  matched: boolean
  url: {
    expectedOrigin: string
    expectedPathPattern: string
    actual: string
    matched: boolean
  }
  signals: PageIdentitySignalEvaluation[]
  matchedSignalCount: number
  requiredSignalCount: number
}

export async function evaluatePageIdentity(
  query: PageIdentityQuery,
  rawPolicy: PageIdentityPolicy,
): Promise<PageIdentityEvaluation> {
  const policy = PageIdentityPolicySchema.parse(rawPolicy)
  const actualUrl = await query.currentUrl()
  const urlMatched = matchesPageUrl(actualUrl, policy)
  const signals: PageIdentitySignalEvaluation[] = []
  for (const signal of policy.signals) {
    try {
      const result = await query.evaluateSignal(signal)
      signals.push({
        kind: signal.kind,
        expected: expectedSignalValue(signal),
        actual: result.actual.slice(0, 2_048),
        matched: result.matched,
      })
    } catch {
      signals.push({
        kind: signal.kind,
        expected: expectedSignalValue(signal),
        actual: 'query-error',
        matched: false,
      })
    }
  }
  const matchedSignalCount = signals.filter((signal) => signal.matched).length
  const requiredSignalCount = policy.match.mode === 'all' ? signals.length : policy.match.count
  return {
    matched: urlMatched && matchedSignalCount >= requiredSignalCount,
    url: {
      expectedOrigin: policy.url.origin,
      expectedPathPattern: policy.url.pathPattern,
      actual: actualUrl,
      matched: urlMatched,
    },
    signals,
    matchedSignalCount,
    requiredSignalCount,
  }
}

function matchesPageUrl(actual: string, policy: PageIdentityPolicy): boolean {
  let url: URL
  try {
    url = new URL(actual)
  } catch {
    return false
  }
  if (url.origin !== policy.url.origin) return false
  return pathPatternExpression(policy.url.pathPattern).test(url.pathname)
}

function pathPatternExpression(pattern: string): RegExp {
  let source = ''
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index]!
    if (character === '/' && pattern[index + 1] === '*' && pattern[index + 2] === '*') {
      source += '(?:/.*)?'
      index += 2
    } else if (character === '*' && pattern[index + 1] === '*') {
      source += '.*'
      index += 1
    } else if (character === '*') source += '[^/]*'
    else source += escapeRegex(character)
  }
  return new RegExp(`^${source}$`, 'u')
}

function escapeRegex(character: string): string {
  return /[\\^$.*+?()[\]{}|]/u.test(character) ? `\\${character}` : character
}

function expectedSignalValue(signal: PageIdentitySignal): string {
  if (signal.kind === 'role') return `${signal.role}:${signal.name}`
  if (signal.kind === 'css-visible') return signal.selector
  return signal.value
}
