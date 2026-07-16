const CROSS_BROWSER_BASELINE = ['CHROMIUM', 'FIREFOX', 'WEBKIT'] as const

export function deriveBrowserCannotClaim(input: {
  approved: Array<{ browserId: string; required: boolean }>
  planned: Array<{ browserId: string }>
  executed: string[]
}): string[] {
  const approved = new Set(input.approved.map((item) => item.browserId))
  const planned = new Set(input.planned.map((item) => item.browserId))
  const executed = new Set(input.executed)
  const missing = CROSS_BROWSER_BASELINE.filter((browserId) =>
    !approved.has(browserId) || !planned.has(browserId) || !executed.has(browserId))
  return missing.length === 0
    ? []
    : [`未完整批准、计划并执行浏览器：${missing.join('、')}；不能宣称跨浏览器兼容性`]
}

export function auditBrowserExecutionBinding(input: {
  approved: Array<{ browserId: string; required: boolean }>
  planned: Array<{ browserId: string }>
  executed: string[]
}): Array<{ code: string; ref: string }> {
  const approved = new Set(input.approved.map((item) => item.browserId))
  const planned = new Set(input.planned.map((item) => item.browserId))
  const executed = new Set(input.executed)
  const findings: Array<{ code: string; ref: string }> = []
  for (const browserId of executed) {
    if (!approved.has(browserId)) findings.push({ code: 'E2E_BROWSER_EXECUTION_NOT_APPROVED', ref: browserId })
    if (!planned.has(browserId)) findings.push({ code: 'E2E_BROWSER_EXECUTION_NOT_PLANNED', ref: browserId })
  }
  for (const item of input.approved) {
    if (item.required && !planned.has(item.browserId)) {
      findings.push({ code: 'E2E_BROWSER_REQUIRED_NOT_PLANNED', ref: item.browserId })
    }
    if (item.required && !executed.has(item.browserId)) {
      findings.push({ code: 'E2E_BROWSER_REQUIRED_NOT_EXECUTED', ref: item.browserId })
    }
  }
  findings.sort((left, right) => left.code < right.code ? -1
    : left.code > right.code ? 1 : left.ref < right.ref ? -1 : left.ref > right.ref ? 1 : 0)
  return findings
}
