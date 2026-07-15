import { existsSync } from 'node:fs'
import { chromium } from 'playwright'

/** 只解析已安装浏览器，不触发下载；CI 可用 E2E_CHROME_EXECUTABLE 显式固定。 */
export function resolveChromeExecutablePath(): string {
  const configured = process.env.E2E_CHROME_EXECUTABLE
  if (configured) {
    if (!existsSync(configured)) throw new Error(`E2E_CHROME_EXECUTABLE 不存在：${configured}`)
    return configured
  }
  const candidates = process.platform === 'darwin'
    ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Chromium.app/Contents/MacOS/Chromium']
    : process.platform === 'linux'
      ? ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser']
      : []
  return candidates.find(existsSync) ?? chromium.executablePath()
}
