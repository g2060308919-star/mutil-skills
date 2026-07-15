import { describe, expect, test } from 'vitest'
import { reconcileEntityLineage } from '../src/index.js'

const entity = (entityKind: 'requirement' | 'rule', entityId: string, semanticKey: string) => ({
  entityKind, entityId, semanticKey, sourceRefs: [`prd.md#${semanticKey}`],
})

describe('stable entity lineage reconciliation', () => {
  test('只按 entityKind + semanticKey 精确保持 ID，并显式记录新增与废弃', () => {
    const mappings = reconcileEntityLineage({
      previous: [
        entity('requirement', 'REQ-ORDER-LIST', 'order:list'),
        entity('rule', 'RULE-LEGACY-FILTER', 'order:legacy-filter'),
      ],
      current: [
        entity('requirement', 'REQ-ORDER-LIST', 'order:list'),
        entity('rule', 'RULE-NEW-SORT', 'order:new-sort'),
      ],
      explicitMappings: [],
    })

    expect(mappings).toEqual([
      expect.objectContaining({ entityKind: 'requirement', semanticKey: 'order:list',
        disposition: 'preserved', previousIds: ['REQ-ORDER-LIST'], currentIds: ['REQ-ORDER-LIST'],
        confirmation: 'deterministic-exact', confidence: 1 }),
      expect.objectContaining({ entityKind: 'rule', semanticKey: 'order:legacy-filter',
        disposition: 'deprecated', previousIds: ['RULE-LEGACY-FILTER'], currentIds: [] }),
      expect.objectContaining({ entityKind: 'rule', semanticKey: 'order:new-sort',
        disposition: 'created', previousIds: [], currentIds: ['RULE-NEW-SORT'] }),
    ])
  })

  test('同 semanticKey 偷换稳定 ID 时 fail-closed，不把重命名伪装成新增/废弃', () => {
    expect(() => reconcileEntityLineage({
      previous: [entity('requirement', 'REQ-STABLE', 'order:list')],
      current: [entity('requirement', 'REQ-CHANGED', 'order:list')],
      explicitMappings: [],
    })).toThrowError(expect.objectContaining({ code: 'E2E_LINEAGE_STABLE_ID_CHANGED' }))
  })

  test('split/merge 只接受覆盖真实快照 ID 的 authority-confirmed 显式映射', () => {
    const previous = [entity('requirement', 'REQ-ORDER', 'order:management')]
    const current = [
      entity('requirement', 'REQ-ORDER-LIST', 'order:list'),
      entity('requirement', 'REQ-ORDER-DETAIL', 'order:detail'),
    ]
    expect(reconcileEntityLineage({ previous, current, explicitMappings: [{
      entityKind: 'requirement', semanticKey: 'order:management', disposition: 'split',
      previousIds: ['REQ-ORDER'], currentIds: ['REQ-ORDER-DETAIL', 'REQ-ORDER-LIST'], confidence: 0.94,
      confirmation: 'authority-confirmed', rationale: '产品负责人确认需求拆分', sourceRefs: ['prd.md#orders'],
    }] })).toEqual([expect.objectContaining({ disposition: 'split', confirmation: 'authority-confirmed' })])

    expect(() => reconcileEntityLineage({ previous, current, explicitMappings: [{
      entityKind: 'requirement', semanticKey: 'order:management', disposition: 'split',
      previousIds: ['REQ-NOT-EXIST'], currentIds: ['REQ-ORDER-DETAIL', 'REQ-ORDER-LIST'], confidence: 0.94,
      confirmation: 'authority-confirmed', rationale: '无效映射', sourceRefs: ['prd.md#orders'],
    }] })).toThrowError(expect.objectContaining({ code: 'E2E_LINEAGE_MAPPING_ENTITY_UNKNOWN' }))
  })

  test('任一 Revision 内 semanticKey 或实体 ID 重复时拒绝对账', () => {
    expect(() => reconcileEntityLineage({
      previous: [entity('requirement', 'REQ-1', 'order:list'), entity('requirement', 'REQ-2', 'order:list')],
      current: [], explicitMappings: [],
    })).toThrowError(expect.objectContaining({ code: 'E2E_LINEAGE_SNAPSHOT_AMBIGUOUS' }))
  })

  test('中文与 ASCII semanticKey 使用 canonical code-unit 顺序，不依赖宿主 locale', () => {
    const current = [
      entity('requirement', 'REQ-ZH', '订单:列表'),
      entity('requirement', 'REQ-ASCII', 'order:list'),
    ]
    const mappings = reconcileEntityLineage({ previous: [], current, explicitMappings: [] })
    expect(mappings.map((mapping) => mapping.semanticKey)).toEqual(['order:list', '订单:列表'])
  })
})
