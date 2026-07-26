export interface SemanticCompletenessInput {
  manifest: Record<string, unknown>
  scope: Record<string, unknown>
  model: Record<string, unknown>
  flows: Record<string, unknown>
  coverage: Record<string, unknown>
  cases: Record<string, unknown>
}

export interface SemanticCompletenessFinding { code: string; ref: string }

export interface SemanticCoverageFacts {
  prdClauses: { covered: number; total: number }
  requirementDesign: { covered: number; total: number }
  rules: { covered: number; total: number }
  oracles: { covered: number; total: number }
  cases: { covered: number; total: number }
}

export interface SemanticTraceabilityRow {
  clauseId: string
  disposition: 'modeled' | 'excluded' | 'not-applicable' | 'ambiguous' | 'missing'
  requirementId?: string
  ruleId?: string
  oracleId?: string
}

export interface SemanticCompletenessAudit {
  findings: SemanticCompletenessFinding[]
  coverageFacts: SemanticCoverageFacts
  traceability: SemanticTraceabilityRow[]
}

/**
 * 独立审计 PRD 条款到 Case 的语义闭环。调用方应先完成单体 Schema 校验；本函数
 * 仍对缺失/畸形集合 fail closed，保证它也可用于 Verdict 的独立复算。
 */
export function auditSemanticCompleteness(input: SemanticCompletenessInput): SemanticCompletenessAudit {
  const findings: SemanticCompletenessFinding[] = []
  const clauses = records(input.manifest.clauses)
  const clauseIds = clauses.map((clause) => text(clause.clauseId)).filter(Boolean)
  const knownClauses = new Set(clauseIds)
  const dispositions = records(input.scope.clauseDispositions)
  const dispositionByClause = new Map<string, Record<string, unknown>[]>()
  for (const disposition of dispositions) {
    const clauseId = text(disposition.clauseId)
    if (!knownClauses.has(clauseId)) add('E2E_PRD_CLAUSE_DISPOSITION_UNKNOWN', clauseId || 'missing')
    const items = dispositionByClause.get(clauseId) ?? []
    items.push(disposition)
    dispositionByClause.set(clauseId, items)
  }
  for (const clauseId of clauseIds) {
    const items = dispositionByClause.get(clauseId) ?? []
    if (items.length === 0) add('E2E_PRD_CLAUSE_DISPOSITION_MISSING', clauseId)
    if (items.length > 1) add('E2E_PRD_CLAUSE_DISPOSITION_DUPLICATE', clauseId)
  }

  const requirements = records(input.model.requirements).filter((requirement) => text(requirement.status) === 'active')
  const requirementById = new Map(requirements.map((requirement) => [text(requirement.reqId), requirement]))
  const includedIds = new Set(records(input.scope.includedReqCandidates).map((candidate) => text(candidate.reqId)))
  const rules = requirements.flatMap((requirement) => records(requirement.rules)
    .map((rule) => ({ requirement, rule })))
  const oracles = requirements.flatMap((requirement) => records(requirement.observableOutcomes)
    .map((oracle) => ({ requirement, oracle })))
  const ruleById = new Map(rules.map((item) => [text(item.rule.ruleId), item]))
  const oracleById = new Map(oracles.map((item) => [text(item.oracle.oracleId), item]))

  for (const requirement of requirements) {
    const reqId = text(requirement.reqId)
    if (!includedIds.has(reqId)) add('E2E_REQUIREMENT_SCOPE_MAPPING_MISSING', reqId)
    validateSourceRefs('E2E_REQUIREMENT_SOURCE_CLAUSE_UNKNOWN', reqId, strings(requirement.sourceRefs))
  }
  for (const { rule } of rules) {
    const ruleId = text(rule.ruleId)
    validateSourceRefs('E2E_RULE_SOURCE_CLAUSE_UNKNOWN', ruleId, strings(rule.sourceRefs))
  }
  for (const { oracle } of oracles) {
    const oracleId = text(oracle.oracleId)
    validateSourceRefs('E2E_ORACLE_SOURCE_CLAUSE_UNKNOWN', oracleId, strings(oracle.sourceRefs))
  }

  for (const [clauseId, items] of dispositionByClause) {
    const disposition = items[0]
    if (!disposition || text(disposition.disposition) !== 'modeled') continue
    const requirementIds = strings(disposition.requirementIds)
    for (const reqId of requirementIds) {
      const requirement = requirementById.get(reqId)
      if (!requirement || !strings(requirement.sourceRefs).includes(clauseId)) {
        add('E2E_PRD_MODELED_CLAUSE_REQUIREMENT_MISMATCH', `${clauseId}:${reqId}`)
      }
    }
    if (requirementIds.length === 0) add('E2E_PRD_MODELED_CLAUSE_REQUIREMENT_MISSING', clauseId)
  }

  const obligations = records(input.coverage.obligations)
  const obligationById = new Map(obligations.map((obligation) => [text(obligation.obligationId), obligation]))
  const coveredRequirements = new Set(obligations.map((obligation) => text(obligation.reqId)))
  const coveredRules = new Set(obligations.flatMap((obligation) => strings(obligation.ruleIds)))
  const coveredOracles = new Set(obligations.flatMap((obligation) => strings(obligation.oracleIds)))
  for (const requirement of requirements) {
    const reqId = text(requirement.reqId)
    if (!coveredRequirements.has(reqId)) add('E2E_REQUIREMENT_COVERAGE_MISSING', reqId)
  }
  for (const { rule } of rules) {
    const ruleId = text(rule.ruleId)
    if (!coveredRules.has(ruleId)) add('E2E_RULE_COVERAGE_MISSING', ruleId)
  }
  for (const { oracle } of oracles) {
    const oracleId = text(oracle.oracleId)
    if (!coveredOracles.has(oracleId)) add('E2E_ORACLE_COVERAGE_MISSING', oracleId)
  }
  for (const obligation of obligations) {
    const obligationId = text(obligation.obligationId)
    const reqId = text(obligation.reqId)
    if (!requirementById.has(reqId)) add('E2E_COVERAGE_REQUIREMENT_UNKNOWN', `${obligationId}:${reqId}`)
    for (const clauseId of strings(obligation.clauseIds)) {
      if (!knownClauses.has(clauseId)) add('E2E_COVERAGE_CLAUSE_UNKNOWN', `${obligationId}:${clauseId}`)
    }
    for (const ruleId of strings(obligation.ruleIds)) {
      if (!ruleById.has(ruleId)) add('E2E_COVERAGE_RULE_UNKNOWN', `${obligationId}:${ruleId}`)
    }
    for (const oracleId of strings(obligation.oracleIds)) {
      if (!oracleById.has(oracleId)) add('E2E_COVERAGE_ORACLE_UNKNOWN', `${obligationId}:${oracleId}`)
    }
  }

  const activeCases = records(input.cases.cases).filter((testCase) => text(testCase.status) === 'active')
  const caseById = new Map(activeCases.map((testCase) => [text(testCase.caseId), testCase]))
  const caseCovered = new Set<string>()
  for (const testCase of activeCases) {
    const caseId = text(testCase.caseId)
    const obligationIds = strings(testCase.obligationIds)
    const stepOracleIds = records(testCase.steps).flatMap((step) =>
      records(step.oracles).map((oracle) => text(oracle.oracleId)).filter(Boolean))
    const validObligations = obligationIds.length > 0 && obligationIds.every((id) => obligationById.has(id))
    const validOracles = stepOracleIds.length > 0 && stepOracleIds.every((id) => oracleById.has(id))
    if (validObligations && validOracles) caseCovered.add(caseId)
    else add('E2E_CASE_DESIGN_INCOMPLETE', caseId)
  }
  for (const { oracle } of oracles) {
    const oracleId = text(oracle.oracleId)
    const caseIds = obligations.filter((obligation) => strings(obligation.oracleIds).includes(oracleId))
      .flatMap((obligation) => {
        const disposition = record(obligation.disposition)
        return text(disposition.kind) === 'automated' ? strings(disposition.caseIds) : []
      })
    const mapped = caseIds.some((caseId) => records(caseById.get(caseId)?.steps)
      .some((step) => records(step.oracles).some((candidate) => text(candidate.oracleId) === oracleId)))
    if (!mapped) add('E2E_ORACLE_CASE_MAPPING_MISSING', oracleId)
  }

  const traceability: SemanticTraceabilityRow[] = []
  for (const clauseId of clauseIds) {
    const disposition = dispositionByClause.get(clauseId)?.[0]
    const rawDisposition = text(disposition?.disposition)
    const dispositionKind: SemanticTraceabilityRow['disposition'] =
      ['modeled', 'excluded', 'not-applicable', 'ambiguous'].includes(rawDisposition)
        ? rawDisposition as SemanticTraceabilityRow['disposition'] : 'missing'
    const linkedRequirements = dispositionKind === 'modeled' ? strings(disposition?.requirementIds) : []
    if (linkedRequirements.length === 0) {
      traceability.push({ clauseId, disposition: dispositionKind })
      continue
    }
    for (const requirementId of linkedRequirements) {
      const requirement = requirementById.get(requirementId)
      const linkedRules = records(requirement?.rules).filter((rule) => strings(rule.sourceRefs).includes(clauseId))
      if (linkedRules.length === 0) traceability.push({ clauseId, disposition: dispositionKind, requirementId })
      for (const rule of linkedRules) {
        const ruleId = text(rule.ruleId)
        const linkedOracles = strings(rule.oracleIds)
        if (linkedOracles.length === 0) traceability.push({ clauseId, disposition: dispositionKind, requirementId, ruleId })
        for (const oracleId of linkedOracles) {
          traceability.push({ clauseId, disposition: dispositionKind, requirementId, ruleId, oracleId })
        }
      }
    }
  }

  const coveredClauseCount = clauseIds.filter((clauseId) => (dispositionByClause.get(clauseId)?.length ?? 0) === 1).length
  const coveredRequirementCount = requirements.filter((requirement) =>
    coveredRequirements.has(text(requirement.reqId))).length
  const coveredRuleCount = rules.filter(({ rule }) => coveredRules.has(text(rule.ruleId))).length
  const coveredOracleCount = oracles.filter(({ oracle }) => coveredOracles.has(text(oracle.oracleId))
    && !findings.some((finding) => finding.code === 'E2E_ORACLE_CASE_MAPPING_MISSING'
      && finding.ref === text(oracle.oracleId))).length

  return {
    findings: uniqueFindings(findings),
    coverageFacts: {
      prdClauses: { covered: coveredClauseCount, total: clauseIds.length },
      requirementDesign: { covered: coveredRequirementCount, total: requirements.length },
      rules: { covered: coveredRuleCount, total: rules.length },
      oracles: { covered: coveredOracleCount, total: oracles.length },
      cases: { covered: caseCovered.size, total: activeCases.length },
    },
    traceability: traceability.sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right))),
  }

  function validateSourceRefs(code: string, ownerId: string, refs: string[]): void {
    if (refs.length === 0) add(code, `${ownerId}:missing`)
    for (const ref of refs) if (!knownClauses.has(ref)) add(code, `${ownerId}:${ref}`)
  }
  function add(code: string, ref: string): void { findings.push({ code, ref }) }
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown> : {}
}
function records(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.map(record) : []
}
function text(value: unknown): string { return typeof value === 'string' ? value : '' }
function strings(value: unknown): string[] { return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [] }
function uniqueFindings(findings: SemanticCompletenessFinding[]): SemanticCompletenessFinding[] {
  return [...new Map(findings.map((finding) => [`${finding.code}\0${finding.ref}`, finding])).values()]
    .sort((left, right) => left.code.localeCompare(right.code) || left.ref.localeCompare(right.ref))
}
