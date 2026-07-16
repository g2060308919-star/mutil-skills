import { describe, expect, test } from 'vitest'
import { computePrdRevision, diffPrdRevision } from '../src/index.js'

const identity = { sourceId: 'PRD-ORDER', version: '2026-07', kind: 'file' }

describe('PRD Revision 与影响范围', () => {
  test('附件引用不变但原始 bytes 变化时必须产生新 Revision', () => {
    const first = computePrdRevision({
      normalizedPrd: '# 订单\r\n请参见附件', sourceIdentity: identity,
      attachments: [{ sourceId: 'ATTACHMENT-RULES', fileName: 'rules.pdf', mediaType: 'application/pdf', bytes: new Uint8Array([1, 2, 3]) }],
    })
    const second = computePrdRevision({
      normalizedPrd: '# 订单\n请参见附件', sourceIdentity: identity,
      attachments: [{ sourceId: 'ATTACHMENT-RULES', fileName: 'rules.pdf', mediaType: 'application/pdf', bytes: new Uint8Array([1, 2, 4]) }],
    })

    expect(first.normalizedPrdDigest).toBe(second.normalizedPrdDigest)
    expect(first.attachments[0]!.contentDigest).not.toBe(second.attachments[0]!.contentDigest)
    expect(first.prdRevision).not.toBe(second.prdRevision)
  })

  test('未有 Schema canonical-sort-key 时保留附件数组顺序语义', () => {
    const attachments = [
      { sourceId: 'ATTACHMENT-A', fileName: 'a.bin', mediaType: 'application/octet-stream', bytes: new Uint8Array([1]) },
      { sourceId: 'ATTACHMENT-B', fileName: 'b.bin', mediaType: 'application/octet-stream', bytes: new Uint8Array([2]) },
    ]
    const forward = computePrdRevision({ normalizedPrd: '# PRD', sourceIdentity: identity, attachments })
    const reversed = computePrdRevision({ normalizedPrd: '# PRD', sourceIdentity: identity, attachments: [...attachments].reverse() })

    expect(forward.prdRevision).not.toBe(reversed.prdRevision)
  })

  test('只将引用变化来源的实体列入重审，未变实体保持稳定 ID', () => {
    const previous = computePrdRevision({
      normalizedPrd: '# 订单', sourceIdentity: identity,
      attachments: [
        { sourceId: 'ATTACHMENT-RULES', fileName: 'rules.pdf', mediaType: 'application/pdf', bytes: new Uint8Array([1]) },
        { sourceId: 'ATTACHMENT-VISUAL', fileName: 'visual.png', mediaType: 'image/png', bytes: new Uint8Array([9]) },
      ],
    })
    const current = computePrdRevision({
      normalizedPrd: '# 订单', sourceIdentity: identity,
      attachments: [
        { sourceId: 'ATTACHMENT-RULES', fileName: 'rules.pdf', mediaType: 'application/pdf', bytes: new Uint8Array([2]) },
        { sourceId: 'ATTACHMENT-VISUAL', fileName: 'visual.png', mediaType: 'image/png', bytes: new Uint8Array([9]) },
      ],
    })
    const diff = diffPrdRevision({
      previous,
      current,
      entities: [
        { entityId: 'REQ-ORDER-RULE', sourceIds: ['ATTACHMENT-RULES'] },
        { entityId: 'REQ-ORDER-VISUAL', sourceIds: ['ATTACHMENT-VISUAL'] },
      ],
    })

    expect(diff).toMatchObject({
      previousRevision: previous.prdRevision,
      currentRevision: current.prdRevision,
      changedSourceIds: ['ATTACHMENT-RULES'],
      impactedEntityIds: ['REQ-ORDER-RULE'],
      stableEntityIds: ['REQ-ORDER-VISUAL'],
      scopeReapprovalRequired: true,
    })
  })

  test('正文或来源身份变化时 fail-closed 重审全部实体，不依赖魔法 sourceId', () => {
    const previous = computePrdRevision({ normalizedPrd: '# 旧 PRD', sourceIdentity: identity, attachments: [] })
    const current = computePrdRevision({ normalizedPrd: '# 新 PRD', sourceIdentity: identity, attachments: [] })
    const diff = diffPrdRevision({
      previous, current,
      entities: [{ entityId: 'REQ-1', sourceIds: [] }, { entityId: 'REQ-2', sourceIds: ['ATTACHMENT-NOT-CHANGED'] }],
    })

    expect(diff.changedSourceIds).toContain('PRD-BODY')
    expect(diff.impactedEntityIds).toEqual(['REQ-1', 'REQ-2'])
    expect(diff.stableEntityIds).toEqual([])

    const identityChanged = computePrdRevision({
      normalizedPrd: '# 旧 PRD', sourceIdentity: { ...identity, version: '2026-08' }, attachments: [],
    })
    const identityDiff = diffPrdRevision({
      previous, current: identityChanged, entities: [{ entityId: 'REQ-1', sourceIds: [] }],
    })
    expect(identityDiff.changedSourceIds).toContain('SOURCE-IDENTITY')
    expect(identityDiff.impactedEntityIds).toEqual(['REQ-1'])
  })
})
