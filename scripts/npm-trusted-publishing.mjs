import { spawn } from 'node:child_process'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const SOURCE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const INTERNAL_SCOPE = '@mutil-skills/'

export function assertTrustedPublishingEnvironment(version, environment = process.env) {
  if (environment.GITHUB_ACTIONS !== 'true') {
    throw new Error('npm Trusted Publishing 只能在 GitHub Actions 中执行')
  }
  if (environment.GITHUB_REF_TYPE !== 'tag') {
    throw new Error('npm Trusted Publishing 只允许 Git Tag 触发')
  }
  if (environment.GITHUB_REF_NAME !== `v${version}`) {
    throw new Error(`发布 Tag ${environment.GITHUB_REF_NAME ?? '<missing>'} 必须与根版本一致: v${version}`)
  }
}

export function topologicalReleaseOrder(manifests, rootVersion) {
  const byName = new Map()
  for (const manifest of manifests) {
    if (typeof manifest.name !== 'string' || !manifest.name.startsWith(INTERNAL_SCOPE)) {
      throw new Error(`非法发布包名: ${String(manifest.name)}`)
    }
    if (byName.has(manifest.name)) throw new Error(`重复发布包: ${manifest.name}`)
    if (manifest.version !== rootVersion) {
      throw new Error(`发布包 ${manifest.name} 版本 ${String(manifest.version)} 与根版本 ${rootVersion} 不一致`)
    }
    byName.set(manifest.name, manifest)
  }

  const dependenciesByName = new Map()
  const dependentsByName = new Map([...byName.keys()].map((name) => [name, []]))
  for (const [name, manifest] of byName) {
    const dependencyEntries = Object.entries({
      ...(manifest.dependencies ?? {}),
      ...(manifest.optionalDependencies ?? {}),
      ...(manifest.peerDependencies ?? {}),
      ...(manifest.devDependencies ?? {}),
    }).filter(([dependency]) => dependency.startsWith(INTERNAL_SCOPE))
    const dependencies = []
    for (const [dependency, version] of dependencyEntries) {
      if (!byName.has(dependency)) throw new Error(`${name} 引用了未发布的内部依赖 ${dependency}`)
      if (version !== rootVersion) {
        throw new Error(`${name} 的内部依赖版本 ${dependency}@${version} 必须为 ${rootVersion}`)
      }
      dependencies.push(dependency)
      dependentsByName.get(dependency).push(name)
    }
    dependenciesByName.set(name, dependencies)
  }

  const ready = [...byName.keys()]
    .filter((name) => dependenciesByName.get(name).length === 0)
    .sort()
  const ordered = []
  while (ready.length > 0) {
    const name = ready.shift()
    ordered.push(byName.get(name))
    for (const dependent of dependentsByName.get(name).sort()) {
      const remaining = dependenciesByName.get(dependent).filter((dependency) => dependency !== name)
      dependenciesByName.set(dependent, remaining)
      if (remaining.length === 0) {
        ready.push(dependent)
        ready.sort()
      }
    }
  }
  if (ordered.length !== manifests.length) throw new Error('发布包内部依赖存在依赖环')
  return ordered
}

export function decideRegistryPublication(localIntegrity, registryIntegrity) {
  if (registryIntegrity === undefined) return 'publish'
  if (registryIntegrity === localIntegrity) return 'skip'
  throw new Error(`Registry 已存在相同版本但完整性冲突: local=${localIntegrity}, registry=${registryIntegrity}`)
}

async function main() {
  const rootManifest = JSON.parse(await readFile(join(SOURCE_ROOT, 'package.json'), 'utf8'))
  assertTrustedPublishingEnvironment(rootManifest.version)
  const manifests = await loadWorkspaceManifests(SOURCE_ROOT)
  const ordered = topologicalReleaseOrder(manifests, rootManifest.version)
  const temporaryRoot = await mkdtemp(join(tmpdir(), 'mutil-trusted-publish-'))
  const results = []
  try {
    for (const manifest of ordered) {
      const pack = await packWorkspace(manifest.name, temporaryRoot)
      const registryIntegrity = await readRegistryIntegrity(manifest.name, manifest.version)
      const decision = decideRegistryPublication(pack.integrity, registryIntegrity)
      if (decision === 'publish') {
        await runNpm(['publish', pack.path, '--access', 'public'], SOURCE_ROOT)
        await waitForRegistryIntegrity(manifest.name, manifest.version, pack.integrity)
      }
      results.push({ name: manifest.name, version: manifest.version, integrity: pack.integrity, decision })
      process.stdout.write(`${JSON.stringify(results.at(-1))}\n`)
    }
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true })
  }
  process.stdout.write(`${JSON.stringify({ ok: true, version: rootManifest.version, packages: results })}\n`)
}

async function loadWorkspaceManifests(sourceRoot) {
  const packagesRoot = join(sourceRoot, 'packages')
  const directories = (await readdir(packagesRoot, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
  return await Promise.all(directories.map(async (directory) => {
    const manifest = JSON.parse(await readFile(join(packagesRoot, directory, 'package.json'), 'utf8'))
    if (manifest.private === true) throw new Error(`发布闭包不得包含 private workspace: ${manifest.name ?? directory}`)
    return manifest
  }))
}

async function packWorkspace(packageName, destination) {
  const output = await runNpm([
    'pack', '--json', '--workspace', packageName, '--pack-destination', destination,
  ], SOURCE_ROOT)
  const parsed = JSON.parse(output)
  if (!Array.isArray(parsed) || parsed.length !== 1
    || typeof parsed[0]?.filename !== 'string' || typeof parsed[0]?.integrity !== 'string') {
    throw new Error(`npm pack 未返回 ${packageName} 的唯一完整性结果`)
  }
  return { path: join(destination, parsed[0].filename), integrity: parsed[0].integrity }
}

async function readRegistryIntegrity(name, version) {
  const result = await runNpmResult(['view', `${name}@${version}`, 'dist.integrity', '--json'], SOURCE_ROOT)
  if (result.code === 0) {
    const integrity = JSON.parse(result.stdout)
    if (typeof integrity !== 'string' || !integrity.startsWith('sha512-')) {
      throw new Error(`Registry 返回了非法完整性: ${name}@${version}`)
    }
    return integrity
  }
  if (result.stderr.includes('E404') || result.stderr.includes('404 Not Found')) return undefined
  throw new Error(`读取 Registry 失败: ${name}@${version}: ${result.stderr.trim()}`)
}

async function waitForRegistryIntegrity(name, version, expectedIntegrity) {
  for (let attempt = 1; attempt <= 12; attempt += 1) {
    const actual = await readRegistryIntegrity(name, version)
    if (actual === expectedIntegrity) return
    if (actual !== undefined) decideRegistryPublication(expectedIntegrity, actual)
    if (attempt < 12) await new Promise((resolveWait) => setTimeout(resolveWait, 10_000))
  }
  throw new Error(`Registry 在 120 秒内未返回已发布包: ${name}@${version}`)
}

async function runNpm(args, cwd) {
  const result = await runNpmResult(args, cwd)
  if (result.code !== 0) throw new Error(`npm ${args[0]} 失败: ${result.stderr.trim()}`)
  return result.stdout
}

async function runNpmResult(args, cwd) {
  return await new Promise((resolveResult, reject) => {
    const child = spawn('npm', args, {
      cwd,
      env: { ...process.env, npm_config_update_notifier: 'false' },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.once('error', reject)
    child.once('close', (code) => resolveResult({ code: code ?? 1, stdout, stderr }))
  })
}

const invokedPath = process.argv[1] === undefined ? undefined : pathToFileURL(resolve(process.argv[1])).href
if (invokedPath === import.meta.url) await main()
