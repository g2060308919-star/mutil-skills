import type { B2BScenarioDefinition } from '../packages/e2e-runtime/src/b2b-scenario-coverage.js'

export const B2B_SCENARIO_CORPUS: B2BScenarioDefinition[] = [
  scenario('SCENARIO-TABLE', 'table-query', '表格查询与行断言', 1),
  scenario('SCENARIO-FILTER', 'filter-sort-pagination', '筛选、排序与分页', 2),
  scenario('SCENARIO-FORM', 'form-validation', '表单输入与校验', 2),
  scenario('SCENARIO-OVERLAY', 'modal-drawer', '弹窗与抽屉', 2),
  scenario('SCENARIO-RICH-INPUT', 'date-cascade-richtext', '日期、级联选择与富文本', 3),
  scenario('SCENARIO-FILE', 'upload-download', '上传、下载与文件内容校验', 3, ['screenshot', 'dom', 'file']),
  scenario('SCENARIO-ROLE', 'authentication-authorization', '多角色权限', 3),
  scenario('SCENARIO-WORKFLOW', 'crud-workflow', '创建、编辑、审核、删除与状态流转', 4),
  scenario('SCENARIO-MULTIPAGE', 'iframe-multipage-async', 'iframe、多页面与异步接口', 4,
    ['screenshot', 'dom', 'url', 'network']),
  scenario('SCENARIO-CLEANUP', 'data-cleanup', '测试数据准备、清理与 reload 验证', 4),
  scenario('SCENARIO-EVIDENCE', 'evidence-assertions', 'DOM、URL、Network、Console 与截图留证', 3,
    ['screenshot', 'dom', 'trace', 'url', 'network', 'console']),
  scenario('SCENARIO-COMPONENT', 'component-adapters', '标准 Locator 与常见组件降级路径', 3),
]

function scenario(
  scenarioId: string,
  category: B2BScenarioDefinition['category'],
  title: string,
  weight: number,
  requiredEvidenceKinds: B2BScenarioDefinition['requiredEvidenceKinds'] = ['screenshot', 'dom', 'trace'],
): B2BScenarioDefinition {
  return { scenarioId, category, title, weight, required: true, minimumPassRate: 1, requiredEvidenceKinds }
}
