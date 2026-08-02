import type { Page } from 'playwright'
import {
  E2EError,
  canonicalizeJson,
  type PageIdentityPolicy,
  type PageIdentitySignal,
} from '@mutil-skills/e2e-contracts'
import type { BrowserPageAdapter, ObservedPageIdentity } from './read-only-runner.js'
import { evaluatePageIdentity, type PageIdentityEvaluation } from './page-identity-policy.js'

export class PlaywrightPageAdapter implements BrowserPageAdapter {
  constructor(readonly page: Page) {}

  async goto(url: string): Promise<void> {
    await this.page.goto(url, { waitUntil: 'domcontentloaded' })
  }

  async identity(): Promise<ObservedPageIdentity> {
    const role = await this.page.locator('html').getAttribute('data-e2e-role')
    const ariaSignals: string[] = []
    const mainHeading = this.page.locator('main h1, main h2, main h3').first()
    if (await mainHeading.count() > 0) ariaSignals.push(`main:${(await mainHeading.textContent())?.trim() ?? ''}`)
    return {
      url: this.page.url(),
      title: await this.page.title(),
      headings: await this.page.locator('h1, h2, h3').allTextContents(),
      ...(role === null ? {} : { role }),
      ariaSignals,
    }
  }

  async evaluateIdentity(policy: PageIdentityPolicy): Promise<PageIdentityEvaluation> {
    return await evaluatePageIdentity({
      currentUrl: () => this.page.url(),
      evaluateSignal: async (signal) => await this.evaluateSignal(signal),
    }, policy)
  }

  async containsText(text: string): Promise<boolean> {
    return await this.page.getByText(text, { exact: false }).count() > 0
  }

  async clickButton(name: string): Promise<void> {
    await this.page.getByRole('button', { name, exact: true }).click()
  }

  async waitForText(text: string): Promise<boolean> {
    try {
      await this.page.getByText(text, { exact: false }).first().waitFor({ state: 'visible' })
      return true
    } catch {
      return false
    }
  }

  async screenshot(): Promise<Uint8Array> {
    const bytes = await this.page.screenshot({ fullPage: true })
    if (bytes.byteLength > 16 * 1024 * 1024) throw evidenceLimit('screenshot')
    return bytes
  }

  async domSnapshot(): Promise<string> {
    // 只捕获 sanitizer 能严格解释的结构化 DOM；输入值、脚本、样式和任意属性
    // 从源头不进入 raw evidence。隐私区域由页面显式 data-e2e-privacy 标记，
    // sanitizer 仍会独立执行字段白名单与高敏模式扫描。
    const snapshot = await this.page.evaluate(() => {
      let nodes = 0
      const visit = (element: Element, depth: number): Record<string, unknown> => {
        nodes += 1
        if (nodes > 10_000 || depth > 64) throw new Error('E2E_RUNTIME_DOM_STRUCTURE_LIMIT')
        const privacy = element.getAttribute('data-e2e-privacy')
        const attributes: Record<string, string> = {}
        for (const name of ['role', 'aria-label', 'data-testid']) {
          const value = element.getAttribute(name)
          if (value !== null) attributes[name] = value.slice(0, 16 * 1024)
        }
        const directText = [...element.childNodes]
          .filter((node) => node.nodeType === Node.TEXT_NODE)
          .map((node) => node.textContent ?? '').join(' ').trim().slice(0, 16 * 1024)
        return {
          tag: element.tagName.toLowerCase(),
          attributes,
          ...(directText === '' ? {} : { text: directText, assertionRelevant: true }),
          ...(element.hasAttribute('hidden') || element.getAttribute('aria-hidden') === 'true'
            ? { hidden: true } : {}),
          ...(['pii', 'secret'].includes(privacy ?? '') ? { privacy } : {}),
          children: [...element.children].map((child) => visit(child, depth + 1)),
        }
      }
      return { format: 'dom-tree/1', roots: [visit(document.documentElement, 0)] }
    })
    const serialized = canonicalizeJson(snapshot)
    if (Buffer.byteLength(serialized, 'utf8') > 4 * 1024 * 1024) throw evidenceLimit('dom')
    return serialized
  }

  private async evaluateSignal(signal: PageIdentitySignal): Promise<{ matched: boolean; actual: string }> {
    if (signal.kind === 'test-id') return await visible(this.page.getByTestId(signal.value))
    if (signal.kind === 'role') {
      return await visible(this.page.getByRole(signal.role, { name: signal.name, exact: true }))
    }
    if (signal.kind === 'css-visible') return await visible(this.page.locator(signal.selector))
    if (signal.kind === 'visible-text') {
      return await visible(this.page.getByText(signal.value, { exact: signal.exact }))
    }
    if (signal.kind === 'heading') {
      return await visible(this.page.getByRole('heading', { name: signal.value, exact: signal.exact }))
    }
    const actual = await this.page.title()
    return {
      matched: signal.exact ? actual === signal.value : actual.includes(signal.value),
      actual,
    }
  }
}

async function visible(locator: ReturnType<Page['locator']>): Promise<{ matched: boolean; actual: string }> {
  const first = locator.first()
  const matched = await first.count() > 0 && await first.isVisible()
  return { matched, actual: matched ? 'visible' : 'missing' }
}

function evidenceLimit(kind: string): E2EError {
  return new E2EError({
    code: 'E2E_RUNTIME_EVIDENCE_SIZE_LIMIT', category: 'evidence',
    message: `E2E_RUNTIME_EVIDENCE_SIZE_LIMIT: ${kind} 证据超过固定上限`, retryable: false,
  })
}
