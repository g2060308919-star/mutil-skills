import {
  E2EError,
  EntityLineageMappingsSchema,
  type EntityLineageMapping,
} from '@mutil-skills/e2e-contracts'

export interface SemanticLineageEntity {
  entityKind: EntityLineageMapping['entityKind']
  entityId: string
  semanticKey: string
  sourceRefs: string[]
}

export function reconcileEntityLineage(input: {
  previous: SemanticLineageEntity[]
  current: SemanticLineageEntity[]
  explicitMappings: EntityLineageMapping[]
}): EntityLineageMapping[] {
  const previous = snapshot(input.previous, 'previous')
  const current = snapshot(input.current, 'current')
  const explicit = EntityLineageMappingsSchema.parse(input.explicitMappings)
  const consumedPrevious = new Set<string>()
  const consumedCurrent = new Set<string>()
  const mappings: EntityLineageMapping[] = []

  for (const mapping of explicit) {
    const previousEntities = mapping.previousIds.map((id) => previous.byId.get(id))
    const currentEntities = mapping.currentIds.map((id) => current.byId.get(id))
    if (previousEntities.some((entity) => !entity || entity.entityKind !== mapping.entityKind)
      || currentEntities.some((entity) => !entity || entity.entityKind !== mapping.entityKind)) {
      throw lineageError('E2E_LINEAGE_MAPPING_ENTITY_UNKNOWN', `lineage 映射引用未知或类型不符实体：${mapping.semanticKey}`)
    }
    const semanticAnchor = mapping.disposition === 'merged'
      ? currentEntities[0]?.semanticKey : previousEntities[0]?.semanticKey ?? currentEntities[0]?.semanticKey
    if (semanticAnchor !== mapping.semanticKey) {
      throw lineageError('E2E_LINEAGE_MAPPING_SEMANTIC_KEY_MISMATCH', `lineage 映射 semanticKey 与实体快照不一致：${mapping.semanticKey}`)
    }
    mapping.previousIds.forEach((id) => consumedPrevious.add(id))
    mapping.currentIds.forEach((id) => consumedCurrent.add(id))
    mappings.push(structuredClone(mapping))
  }

  const remainingKeys = new Set<string>()
  for (const entity of previous.entities) {
    if (!consumedPrevious.has(entity.entityId)) remainingKeys.add(keyOf(entity))
  }
  for (const entity of current.entities) {
    if (!consumedCurrent.has(entity.entityId)) remainingKeys.add(keyOf(entity))
  }

  for (const key of [...remainingKeys].sort()) {
    const before = previous.byKey.get(key)
    const after = current.byKey.get(key)
    if (before && consumedPrevious.has(before.entityId)) continue
    if (after && consumedCurrent.has(after.entityId)) continue
    if (before && after && before.entityId !== after.entityId) {
      throw lineageError(
        'E2E_LINEAGE_STABLE_ID_CHANGED',
        `相同 semanticKey 禁止更换稳定 ID：${before.entityId} -> ${after.entityId}`,
      )
    }
    const common = {
      entityKind: (before ?? after)!.entityKind,
      semanticKey: (before ?? after)!.semanticKey,
      confidence: 1,
      confirmation: 'deterministic-exact' as const,
      sourceRefs: [...new Set([...(before?.sourceRefs ?? []), ...(after?.sourceRefs ?? [])])].sort(),
    }
    if (before && after) mappings.push({
      ...common, disposition: 'preserved', previousIds: [before.entityId], currentIds: [after.entityId],
      rationale: 'entityKind 与 semanticKey 精确一致，稳定 ID 保持不变',
    })
    else if (before) mappings.push({
      ...common, disposition: 'deprecated', previousIds: [before.entityId], currentIds: [],
      rationale: '旧 Revision 存在且新 Revision 不再包含该 semanticKey',
    })
    else if (after) mappings.push({
      ...common, disposition: 'created', previousIds: [], currentIds: [after.entityId],
      rationale: '新 Revision 首次出现该 semanticKey',
    })
  }

  mappings.sort((left, right) => compareCanonicalText(keyOf(left), keyOf(right)))
  return EntityLineageMappingsSchema.parse(mappings)
}

function snapshot(entities: SemanticLineageEntity[], label: string) {
  const copy = structuredClone(entities)
  const byId = new Map<string, SemanticLineageEntity>()
  const byKey = new Map<string, SemanticLineageEntity>()
  for (const entity of copy) {
    if (!/^[A-Za-z0-9._:-]+$/.test(entity.entityId) || entity.semanticKey.length === 0
      || entity.sourceRefs.length === 0 || entity.sourceRefs.some((ref) => ref.length === 0)
      || byId.has(entity.entityId) || byKey.has(keyOf(entity))) {
      throw lineageError('E2E_LINEAGE_SNAPSHOT_AMBIGUOUS', `${label} Revision 实体 ID/semanticKey 不唯一或字段无效`)
    }
    byId.set(entity.entityId, entity)
    byKey.set(keyOf(entity), entity)
  }
  return { entities: copy, byId, byKey }
}

function keyOf(entity: Pick<SemanticLineageEntity, 'entityKind' | 'semanticKey'>): string {
  return `${entity.entityKind}\0${entity.semanticKey}`
}

function compareCanonicalText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function lineageError(code: string, message: string): E2EError {
  return new E2EError({ code, category: 'validation', message, retryable: false })
}
