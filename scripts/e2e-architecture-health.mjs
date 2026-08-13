import { readFile, readdir } from 'node:fs/promises'
import { basename, join, relative } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createHash } from 'node:crypto'

export async function analyzeArchitectureHealth(root = process.cwd()) {
  const packagesRoot = join(root, 'packages')
  const packageDirectories = await directories(packagesRoot)
  const packages = []
  for (const directory of packageDirectories) {
    const packageRoot = join(packagesRoot, directory)
    const manifest = await json(join(packageRoot, 'package.json'))
    const sourceFiles = await collect(join(packageRoot, 'src')).catch(() => [])
    packages.push({ directory, name: String(manifest.name ?? directory), sourceFiles,
      dependencies: Object.keys({ ...(manifest.dependencies ?? {}), ...(manifest.peerDependencies ?? {}) }) })
  }
  const byName = new Map(packages.map((item) => [item.name, item]))
  const graph = Object.fromEntries(packages.map((item) => [item.name,
    item.dependencies.filter((dependency) => byName.has(dependency)).sort()]))
  const findings = []
  for (const cycle of cycles(graph)) findings.push(finding('E2E_ARCH_PACKAGE_CYCLE', 'error', cycle.join(' -> ')))

  const allowedStateAuthorities = new Set([
    'packages/e2e-runtime/src/runtime-host.ts', 'packages/e2e-engine/src/workflow.ts',
  ])
  const files = packages.flatMap((item) => item.sourceFiles)
  const metrics = []
  for (const file of files) {
    const source = await readFile(file, 'utf8')
    const path = relative(root, file).split('\\').join('/')
    const lines = source.split('\n').length
    const exports = (source.match(/\bexport\s+(?:async\s+)?(?:class|function|const|interface|type|enum)\b/g) ?? []).length
    metrics.push({ path, lines, exports, passThrough: isPassThrough(source),
      recoveryBoundary: /recover|resume|checkpoint|cleanup|retire/i.test(basename(file)) })
    if (!allowedStateAuthorities.has(path)
      && /(?:export\s+)?(?:async\s+)?function\s+(?:transitionWorkflow|decideWorkflow)|class\s+\w*(?:Controller|StateMachine)\b/.test(source)) {
      findings.push(finding('E2E_ARCH_SECOND_STATE_AUTHORITY', 'error', path))
    }
    if (basename(file) === 'index.ts'
      && /\b(?:create|authorize)?Test\w*(?:Capability|Session)\b/.test(source)) {
      findings.push(finding('E2E_ARCH_TEST_CAPABILITY_EXPORTED', 'error', path))
    }
  }
  const body = {
    schemaVersion: 'e2e-architecture-health/v1', generatedAt: new Date().toISOString(),
    topology: graph, authorities: { runtimeState: 'packages/e2e-runtime/src/runtime-host.ts',
      transitionPolicy: 'packages/e2e-engine/src/workflow.ts' },
    metrics: { files: metrics, publicExports: metrics.reduce((total, item) => total + item.exports, 0),
      passThroughModules: metrics.filter((item) => item.passThrough).map((item) => item.path),
      largeFileSignals: metrics.filter((item) => item.lines >= 1_000).map((item) => ({ path: item.path, lines: item.lines })),
      recoveryBoundaries: metrics.filter((item) => item.recoveryBoundary).map((item) => item.path) },
    findings: findings.sort((a, b) => a.code.localeCompare(b.code) || a.location.localeCompare(b.location)),
    gate: { passed: findings.every((item) => item.severity !== 'error') },
  }
  return { ...body, reportDigest: `sha256:${createHash('sha256').update(JSON.stringify(body)).digest('hex')}` }
}

function finding(code, severity, location) { return { code, severity, location } }
function isPassThrough(source) {
  const meaningful = source.split('\n').filter((line) => line.trim() && !line.trim().startsWith('//'))
  return meaningful.length > 0 && meaningful.every((line) => /^\s*export\s+\*\s+from\s+/.test(line))
}
function cycles(graph) {
  const found = new Map(); const visited = new Set(); const active = []; const activeSet = new Set()
  const visit = (node) => {
    if (activeSet.has(node)) {
      const cycle = [...active.slice(active.indexOf(node)), node]
      const key = [...new Set(cycle.slice(0, -1))].sort().join('|'); found.set(key, cycle); return
    }
    if (visited.has(node)) return
    active.push(node); activeSet.add(node)
    for (const dependency of graph[node] ?? []) visit(dependency)
    active.pop(); activeSet.delete(node); visited.add(node)
  }
  for (const node of Object.keys(graph)) visit(node)
  return [...found.values()]
}
async function directories(path) {
  return (await readdir(path, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name)
}
async function collect(path) {
  const output = []
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const child = join(path, entry.name)
    if (entry.isDirectory()) output.push(...await collect(child))
    else if (entry.isFile() && entry.name.endsWith('.ts')) output.push(child)
  }
  return output
}
async function json(path) { return JSON.parse(await readFile(path, 'utf8')) }

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const report = await analyzeArchitectureHealth()
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
  if (!report.gate.passed) process.exitCode = 1
}
