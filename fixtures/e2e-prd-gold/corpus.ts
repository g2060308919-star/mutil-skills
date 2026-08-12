import type { PrdGoldCorpus } from '../../packages/e2e-engine/src/prd-gold-scorer.js'

interface EntrySeed {
  id: string
  category: string
  prd: string
  actor: string
  precondition: string
  classification: 'ambiguous' | 'excluded' | 'not-applicable' | 'manual' | 'unsupported'
}

const seeds: EntrySeed[] = [
  { id: 'crud-reload', category: 'crud-reload-persistence', actor: 'editor', precondition: '存在可编辑记录', classification: 'not-applicable',
    prd: '编辑者可创建、读取、更新和删除记录；空标题不得保存；重复提交只产生一条记录；Reload 后更新仍存在。删除测试记录作为 Cleanup。' },
  { id: 'state-transition', category: 'state-transition-invalid', actor: 'operator', precondition: '订单处于 draft', classification: 'ambiguous',
    prd: '订单可从 draft 提交为 pending；不能从 draft 直接完成；重复提交保持 pending；Reload 后状态不变。PRD 未说明 pending 能否撤回。' },
  { id: 'admin-permission', category: 'admin-user-permission', actor: 'admin', precondition: '存在待审核记录', classification: 'ambiguous',
    prd: '只有管理员可审核；普通用户无按钮；绕过前端直接审核必须失败；Reload 后保持已通过。PRD 未说明审核能否撤销。' },
  { id: 'empty-value', category: 'empty-null-validation', actor: 'member', precondition: '打开新建表单', classification: 'not-applicable',
    prd: '成员可提交有效姓名；空字符串、仅空格和 null 不得创建；修正后可成功；Reload 后记录存在。' },
  { id: 'duplicate-submit', category: 'duplicate-submit-idempotency', actor: 'buyer', precondition: '结算页有一个商品', classification: 'ambiguous',
    prd: '买家单击支付可创建订单；连续双击不能产生重复订单；失败后显示错误；Reload 后只显示一个订单。PRD 未说明重试间隔。' },
  { id: 'dynamic-form', category: 'dynamic-form-visibility', actor: 'applicant', precondition: '申请类型为空', classification: 'not-applicable',
    prd: '选择企业类型后显示税号字段；切回个人后隐藏并清空税号；无效税号阻止提交；Reload 后保存的类型正确。' },
  { id: 'form-cascade', category: 'form-dependent-options', actor: 'planner', precondition: '国家和城市未选择', classification: 'ambiguous',
    prd: '选择国家后仅显示对应城市；切换国家清除旧城市；伪造不属于该国家的城市必须失败；PRD 未定义国家下线后的行为。' },
  { id: 'batch-partial', category: 'batch-partial-failure', actor: 'admin', precondition: '列表含可删和受保护记录', classification: 'manual',
    prd: '批量删除时可删除记录成功、受保护记录失败；页面分别展示成功和失败；Reload 后结果保持；后端告警仅人工核对。' },
  { id: 'async-poll', category: 'async-eventual-state', actor: 'operator', precondition: '任务尚未启动', classification: 'ambiguous',
    prd: '启动任务后显示处理中；轮询最终显示成功；失败状态不得显示成功文案；Reload 后可读取最终状态。PRD 未定义最长处理时间。' },
  { id: 'fixture-cleanup', category: 'fixture-cleanup-absence', actor: 'tester', precondition: '租户为空', classification: 'not-applicable',
    prd: '测试前创建唯一 Fixture；操作只影响该 Fixture；测试后 Cleanup 删除；再次查询必须不存在；其他租户数据不受影响。' },
  { id: 'excluded-export', category: 'explicit-exclusion', actor: 'analyst', precondition: '报表已有数据', classification: 'excluded',
    prd: '本次仅验证报表筛选和分页；导出明确排除；无结果显示空态；非法页码回到第一页；Reload 保留筛选。' },
  { id: 'manual-visual', category: 'manual-visual-oracle', actor: 'designer', precondition: '主题设为 light', classification: 'manual',
    prd: '切换 dark 后主题属性更新；按钮仍可操作；Reload 保持 dark；品牌视觉一致性由人工 Oracle 判断，不得自动判通过。' },
  { id: 'unsupported-device', category: 'unsupported-device-capability', actor: 'mobile-user', precondition: '桌面 Chrome 环境', classification: 'unsupported',
    prd: '桌面响应式布局可验证；真实陀螺仪手势需要设备能力，当前环境 unsupported；不得伪造已通过；Reload 保持布局设置。' },
  { id: 'not-applicable-billing', category: 'not-applicable-domain', actor: 'free-user', precondition: '免费方案租户', classification: 'not-applicable',
    prd: '免费用户可查看额度；不能调用付费功能；账单地址对免费方案 not-applicable；绕过入口仍失败；Reload 后额度不变。' },
  { id: 'cross-tenant', category: 'tenant-data-isolation', actor: 'tenant-admin', precondition: '两个租户各有记录', classification: 'ambiguous',
    prd: '租户管理员只能查看和修改本租户记录；篡改 ID 访问其他租户失败；Reload 后隔离仍成立。PRD 未说明平台管理员例外。' },
  { id: 'popup', category: 'popup-multi-page', actor: 'support', precondition: '帮助入口可见', classification: 'excluded',
    prd: '打开帮助会创建受信任 Popup；原页面保持；恶意外域导航被阻止；关闭 Popup 后原页面可继续；第三方内容正确性排除。' },
  { id: 'json-write', category: 'json-write-verification', actor: 'editor', precondition: '记录版本为 1', classification: 'ambiguous',
    prd: '保存以 JSON Body 写入标题；成功响应后页面显示新标题；Reload 后仍为新标题；版本冲突失败。PRD 未说明冲突合并策略。' },
  { id: 'search-boundary', category: 'search-boundary-result', actor: 'viewer', precondition: '目录含多个名称', classification: 'not-applicable',
    prd: '完整词和前缀可搜索；空查询显示默认列表；超长查询显示校验；无结果显示空态；Reload 后查询参数可恢复。' },
  { id: 'pagination', category: 'pagination-boundary', actor: 'viewer', precondition: '列表超过一页', classification: 'ambiguous',
    prd: '下一页展示不同记录；第一页无上一页；最后一页无下一页；删除末页最后记录后页码修正。PRD 未定义页大小变化。' },
  { id: 'session-expiry', category: 'session-expiry-authentication', actor: 'member', precondition: '会话接近过期', classification: 'manual',
    prd: '有效会话可读取页面；过期后写操作失败并跳登录；返回后不得自动重放不确定写；身份提供商登录由人工验证；Reload 不泄露旧数据。' },
]

function makeEntry(seed: EntrySeed): PrdGoldCorpus['entries'][number] {
  const prefix = seed.id
  const requirements = [`REQ-${prefix}`]
  const rules = [`RULE-${prefix}-allow`, `RULE-${prefix}-deny`]
  const obligations = [`OBL-${prefix}-positive`, `OBL-${prefix}-negative`, `OBL-${prefix}-edge`,
    `OBL-${prefix}-reload`, `OBL-${prefix}-cleanup`]
  const negativeEdgeObligations = [obligations[1]!, obligations[2]!]
  const oracles = obligations.map((_, index) => `ORACLE-${prefix}-${index + 1}`)
  const cases = obligations.map((_, index) => `CASE-${prefix}-${index + 1}`)
  const dataNeeds = [`DATA-${prefix}`]
  const cleanup = [`CLEANUP-${prefix}`]
  const classifications = [{ semanticId: `CLASS-${prefix}`, disposition: seed.classification }]
  const gold = { requirements, rules, obligations, negativeEdgeObligations, oracles, classifications,
    cases, dataNeeds, cleanup }
  const adjudications = [
    ...requirements.map((semanticId) => ({ semanticId, kind: 'requirement' as const,
      statement: `人工确认需求：${seed.prd}` })),
    ...rules.map((semanticId, index) => ({ semanticId, kind: 'rule' as const,
      statement: index === 0 ? '允许的主路径及可观察结果' : '明确拒绝的负向路径及边界' })),
    ...obligations.map((semanticId, index) => ({ semanticId, kind: 'obligation' as const,
      statement: ['正向主路径', '负向拒绝路径', '边界与非法输入', 'Reload 后状态', 'Fixture Cleanup 后不存在'][index]! })),
    ...cases.map((semanticId, index) => ({ semanticId, kind: 'case' as const,
      statement: `执行对应义务 ${obligations[index]}` })),
    ...oracles.map((semanticId, index) => ({ semanticId, kind: 'oracle' as const,
      statement: `可观察验证对应义务 ${obligations[index]}` })),
    ...dataNeeds.map((semanticId) => ({ semanticId, kind: 'data-need' as const,
      statement: `隔离数据：${seed.precondition}` })),
    ...cleanup.map((semanticId) => ({ semanticId, kind: 'cleanup' as const,
      statement: '删除本用例创建或修改的隔离资源，并验证不存在' })),
    ...classifications.map(({ semanticId, disposition }) => ({ semanticId, kind: 'classification' as const,
      statement: `人工裁决为 ${disposition}，禁止凭空补规则` })),
  ]
  return {
    entryId: `GOLD-${prefix}`,
    category: seed.category,
    prd: seed.prd,
    sourceSpans: [{ clauseId: `CLAUSE-${prefix}`, startLine: 1, endLine: 1 }],
    actors: [seed.actor],
    preconditions: [seed.precondition],
    adjudications,
    gold,
    samples: [{ sample: 0, candidate: { ...gold } }],
  }
}

export const prdGoldCorpus: PrdGoldCorpus = {
  schemaVersion: 'prd-gold-corpus/v1',
  corpusVersion: '1.0.0',
  adjudicationVersion: '1.0.0',
  entries: seeds.map(makeEntry),
}
