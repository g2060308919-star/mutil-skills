import { describe, expect, test } from 'vitest'
import { renderDeclarativeBrowserCase } from '../src/declarative-browser-renderer.js'
import type { DeclarativeBrowserAction, DeclarativeOracleObservation } from '@mutil-skills/e2e-contracts'

const scope = { page: 'current' as const, frame: { kind: 'main' as const } }
const timeout = { timeoutMs: 5_000, retry: 'read-only-max-2' as const }
const role = (roleName: 'button' | 'textbox' | 'checkbox', name: string) =>
  [{ kind: 'role' as const, role: roleName, name }]

describe('declarative browser renderer', () => {
  test('确定性覆盖首批动作、页面作用域与全部 Oracle，不接收自由源码', () => {
    const program: { caseId: string; actions: DeclarativeBrowserAction[]; oracles: DeclarativeOracleObservation[] } = {
      caseId: 'CASE-1',
      actions: [
        action({ kind: 'navigate', actionId: 'A-1', locatorCandidates: [], url: 'https://example.test/todos' }),
        action({ kind: 'fill', actionId: 'A-2', locatorCandidates: role('textbox', '待办事项'), value: '完成发布' }),
        action({ kind: 'press', actionId: 'A-3', locatorCandidates: role('textbox', '待办事项'), key: 'Enter' }),
        action({ kind: 'click', actionId: 'A-4', locatorCandidates: role('button', '详情') }),
        action({ kind: 'select', actionId: 'A-5', locatorCandidates: role('textbox', '优先级'), values: ['高'] }),
        action({ kind: 'check', actionId: 'A-6', locatorCandidates: role('checkbox', '已完成'), checked: true }),
        action({ kind: 'wait-for', actionId: 'A-7', locatorCandidates: [{ kind: 'text', value: '已保存', exact: true }], state: 'visible' }),
        action({ kind: 'assert-only', actionId: 'A-8', locatorCandidates: [] }),
      ],
      oracles: [
        oracle({ kind: 'text', oracleId: 'O-1', actionId: 'A-7',
          locatorCandidates: [{ kind: 'text', value: '完成发布', exact: true }], comparator: 'equals', expected: '完成发布' }),
        oracle({ kind: 'absence', oracleId: 'O-2', actionId: 'A-8',
          locatorCandidates: [{ kind: 'text', value: '加载失败', exact: true }] }),
        oracle({ kind: 'url', oracleId: 'O-3', actionId: 'A-8', comparator: 'contains', expected: '/todos' }),
        oracle({ kind: 'element-state', oracleId: 'O-4', actionId: 'A-8',
          locatorCandidates: role('checkbox', '已完成'), state: 'checked', expected: true }),
        oracle({ kind: 'eventually', oracleId: 'O-5', actionId: 'A-8',
          locatorCandidates: [{ kind: 'text', value: '已同步', exact: true }], observation: 'text',
          comparator: 'contains', expected: '已同步' }),
        oracle({ kind: 'reload-state', oracleId: 'O-6', actionId: 'A-8', observation: 'text',
          locatorCandidates: [{ kind: 'text', value: '完成发布', exact: true }], expected: '完成发布' }),
      ],
    }

    const first = renderDeclarativeBrowserCase(program)
    const second = renderDeclarativeBrowserCase(structuredClone(program))
    expect(first).toBe(second)
    expect(first).toContain("await page.goto(\"https://example.test/todos\"")
    expect(first).toContain('.fill("完成发布"')
    expect(first).toContain('.press("Enter"')
    expect(first).toContain('.click(')
    expect(first).toContain('.selectOption(["高"]')
    expect(first).toContain('.check(')
    expect(first).toContain("waitFor({ state: \"visible\"")
    expect(first).toContain('await page.reload(')
    expect(first).toContain('O-1')
    expect(first).toContain('O-6')
    expect(first).not.toMatch(/eval\(|Function\(|process\.env/)
  })

  test('popup 或 frame 作用域没有显式可信绑定时 fail closed', () => {
    expect(() => renderDeclarativeBrowserCase({ caseId: 'CASE-1', actions: [action({
      kind: 'click', actionId: 'A-1', locatorCandidates: role('button', '打开'),
      pageScope: { page: 'popup', pageId: 'POPUP-1', frame: { kind: 'main' } },
    })], oracles: [] })).toThrow('E2E_COMPILER_DECLARATIVE_SCOPE_UNSUPPORTED')
  })
})

function action(value: Record<string, unknown>): DeclarativeBrowserAction {
  return { effect: 'read', pageScope: scope, timeout, ...value } as DeclarativeBrowserAction
}

function oracle(value: Record<string, unknown>): DeclarativeOracleObservation {
  return { deadlineMs: 5_000, evidenceKinds: ['screenshot'], ...value } as DeclarativeOracleObservation
}
