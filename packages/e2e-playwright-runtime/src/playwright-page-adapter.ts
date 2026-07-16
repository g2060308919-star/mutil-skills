import type { Page } from 'playwright'
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
    return this.page.screenshot({ fullPage: true })
  }

  async domSnapshot(): Promise<string> {
    const main = this.page.locator('main')
    if (await main.count() > 0) return main.first().evaluate((element) => element.outerHTML)
    return this.page.locator('body').evaluate((element) => element.outerHTML)
  }
}
