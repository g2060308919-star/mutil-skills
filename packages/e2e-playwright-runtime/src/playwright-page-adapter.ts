import type { Page } from 'playwright'
import { E2EError, canonicalizeJson } from '@mutil-skills/e2e-contracts'
import type { BrowserPageAdapter, ObservedPageIdentity } from './read-only-runner.js'

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
    const session = await this.page.context().newCDPSession(this.page)
    try {
      const snapshot = await session.send('DOMSnapshot.captureSnapshot', {
        computedStyles: [], includeDOMRects: false, includePaintOrder: false,
      })
      const serialized = canonicalizeJson(snapshot)
      if (Buffer.byteLength(serialized, 'utf8') > 4 * 1024 * 1024) throw evidenceLimit('dom')
      return serialized
    } finally { await session.detach() }
  }
}

function evidenceLimit(kind: string): E2EError {
  return new E2EError({
    code: 'E2E_RUNTIME_EVIDENCE_SIZE_LIMIT', category: 'evidence',
    message: `E2E_RUNTIME_EVIDENCE_SIZE_LIMIT: ${kind} 证据超过固定上限`, retryable: false,
  })
}
