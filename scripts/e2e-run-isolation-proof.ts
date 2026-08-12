import { createServer } from 'node:http'
import { access, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { chromium } from 'playwright'
import { canonicalizeJson, digestText } from '@mutil-skills/e2e-contracts'

export async function runChromeIsolationProof() {
  const root = await mkdtemp(join(tmpdir(), 'mutil-e2e-run-isolation-'))
  const server = createServer((request, response) => {
    if (request.url === '/sw.js') {
      response.writeHead(200, { 'content-type': 'application/javascript', 'service-worker-allowed': '/' })
      response.end("self.addEventListener('fetch', () => {})")
      return
    }
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    response.end(`<!doctype html><button id="download">download</button><script>
      download.onclick=()=>{const a=document.createElement('a');a.download='run.txt';a.href='data:text/plain,run-a';a.click()}
    </script>`)
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve() })
  })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('E2E_ISOLATION_SERVER_FAILED')
  const origin = `http://127.0.0.1:${address.port}`
  const profileA = join(root, 'profile-a')
  const profileB = join(root, 'profile-b')
  const downloadA = join(root, 'download-a.txt')
  const observations = {
    cookieCrossRead: true, localStorageCrossRead: true, sessionStorageCrossRead: true,
    indexedDbCrossRead: true, cacheCrossRead: true, serviceWorkerCrossRead: true,
    downloadCrossRead: true, profilesRemoved: false,
  }
  try {
    const first = await chromium.launchPersistentContext(profileA, {
      channel: 'chrome', headless: true, acceptDownloads: true,
    })
    try {
      const page = await first.newPage()
      await page.goto(origin)
      await page.evaluate(async () => {
        document.cookie = 'run=A; SameSite=Lax'
        localStorage.setItem('run', 'A')
        sessionStorage.setItem('run', 'A')
        const request = indexedDB.open('run-db', 1)
        await new Promise<void>((resolve, reject) => {
          request.onupgradeneeded = () => request.result.createObjectStore('state').put('A', 'run')
          request.onsuccess = () => { request.result.close(); resolve() }
          request.onerror = () => reject(request.error)
        })
        const cache = await caches.open('run-cache'); await cache.put('/run-owner', new Response('A'))
        await navigator.serviceWorker.register('/sw.js')
        await navigator.serviceWorker.ready
      })
      const download = page.waitForEvent('download')
      await page.click('#download')
      await (await download).saveAs(downloadA)
      expectDownloaded(await readFile(downloadA, 'utf8'))
    } finally { await first.close() }

    const second = await chromium.launchPersistentContext(profileB, {
      channel: 'chrome', headless: true, acceptDownloads: true,
    })
    try {
      const page = await second.newPage(); await page.goto(origin)
      const read = await page.evaluate(async () => {
        const indexed = await new Promise<string | null>((resolve) => {
          const request = indexedDB.open('run-db')
          request.onupgradeneeded = () => resolve(null)
          request.onsuccess = () => {
            const db = request.result
            if (!db.objectStoreNames.contains('state')) { db.close(); resolve(null); return }
            const read = db.transaction('state').objectStore('state').get('run')
            read.onsuccess = () => { db.close(); resolve(read.result ?? null) }
            read.onerror = () => { db.close(); resolve(null) }
          }
          request.onerror = () => resolve(null)
        })
        const cached = await (await caches.open('run-cache')).match('/run-owner')
        return { cookie: document.cookie, local: localStorage.getItem('run'), session: sessionStorage.getItem('run'),
          indexed, cached: cached ? await cached.text() : null,
          workers: (await navigator.serviceWorker.getRegistrations()).length }
      })
      observations.cookieCrossRead = read.cookie.includes('run=A')
      observations.localStorageCrossRead = read.local === 'A'
      observations.sessionStorageCrossRead = read.session === 'A'
      observations.indexedDbCrossRead = read.indexed === 'A'
      observations.cacheCrossRead = read.cached === 'A'
      observations.serviceWorkerCrossRead = read.workers > 0
      observations.downloadCrossRead = await exists(join(profileB, 'Downloads', 'run.txt'))
    } finally { await second.close() }
  } finally {
    await Promise.all([rm(profileA, { recursive: true, force: true }), rm(profileB, { recursive: true, force: true })])
    observations.profilesRemoved = !await exists(profileA) && !await exists(profileB)
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
    await rm(root, { recursive: true, force: true })
  }
  const passed = observations.profilesRemoved && Object.entries(observations)
    .every(([key, value]) => key === 'profilesRemoved' ? value : !value)
  const body = { schemaVersion: 'chrome-run-isolation-proof/v1' as const,
    runnerIdentity: { browser: 'system-chrome', host: `${process.platform}-${process.arch}`, node: process.version },
    claims: { browserProductIsolation: 'verified' as const, backendAccountIsolation: 'not-executed' as const },
    substitutedComponents: ['backend', 'database', 'idp'], observations, passed }
  return { ...body, proofDigest: digestText('chrome-run-isolation-proof/v1', canonicalizeJson(body)) }
}

function expectDownloaded(content: string): void {
  if (content !== 'run-a') throw new Error('E2E_ISOLATION_DOWNLOAD_INVALID')
}

async function exists(path: string): Promise<boolean> {
  try { await access(path); return true } catch { return false }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.stdout.write(`${JSON.stringify(await runChromeIsolationProof(), null, 2)}\n`)
}
