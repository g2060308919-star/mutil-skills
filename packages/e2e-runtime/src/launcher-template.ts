import type { RuntimeLayout } from './runtime-layout.js'
import { RUNTIME_ENTRYPOINT, RUNTIME_MANIFEST_FILE } from './runtime-manifest.js'

export function fixedLauncherSource(layout: RuntimeLayout): string {
  const configuration = JSON.stringify({
    current: layout.current,
    versions: layout.versions,
    entrypoint: RUNTIME_ENTRYPOINT,
    manifest: RUNTIME_MANIFEST_FILE,
  })
  const nodeExecutable = shellSingleQuote(process.execPath)
  return `#!/bin/sh
':' //; unset NODE_OPTIONS NODE_PATH; if [ ! -x ${nodeExecutable} ]; then printf '%s\\n' 'E2E_RUNTIME_NODE_EXECUTABLE_UNAVAILABLE' >&2; exit 70; fi; exec ${nodeExecutable} "$0" "$@"
'use strict'
const { createHash } = require('node:crypto')
const { lstatSync, readFileSync, realpathSync } = require('node:fs')
const { spawn } = require('node:child_process')
const { isAbsolute, join, relative, sep } = require('node:path')
const configuration = ${configuration}

try {
  if ((process.platform !== 'darwin' && process.platform !== 'linux')
    || process.execArgv.some((argument) => argument === '--loader'
      || argument.startsWith('--loader=')
      || argument === '--require'
      || argument.startsWith('--require='))) {
    fail()
  }
  const current = readPrivateJson(configuration.current)
  exactKeys(current, ['protocolMajor', 'runtimeManifestDigest', 'runtimeVersion', 'schemaVersion', 'versionRoot'])
  if (current.schemaVersion !== '1.0.0'
    || !/^(?:0|[1-9]\\d*)\\.(?:0|[1-9]\\d*)\\.(?:0|[1-9]\\d*)$/.test(current.runtimeVersion)
    || current.protocolMajor !== 1
    || !/^sha256:[a-f0-9]{64}$/.test(current.runtimeManifestDigest)
    || !isAbsolute(current.versionRoot)) fail()

  const expectedRoot = join(configuration.versions, current.runtimeVersion)
  privateDirectory(configuration.versions)
  privateDirectory(expectedRoot)
  const versionsRoot = realpathSync(configuration.versions)
  const versionRoot = realpathSync(expectedRoot)
  within(versionsRoot, versionRoot)
  if (versionRoot === versionsRoot || current.versionRoot !== versionRoot) fail()

  const manifest = readPrivateJson(join(versionRoot, configuration.manifest))
  exactKeys(manifest, ['files', 'installationDigest', 'schemaVersion'])
  if (manifest.schemaVersion !== '1.0.0'
    || manifest.installationDigest !== current.runtimeManifestDigest
    || !Array.isArray(manifest.files)) fail()
  let previousPath
  for (const record of manifest.files) {
    if (!record || typeof record !== 'object' || Array.isArray(record)) fail()
    exactKeys(record, ['byteLength', 'digest', 'path'])
    if (typeof record.path !== 'string'
      || record.path.length === 0
      || record.path.startsWith('/')
      || record.path.includes('\\\\')
      || record.path.split('/').some((part) => part === '' || part === '.' || part === '..')
      || !Number.isSafeInteger(record.byteLength)
      || record.byteLength < 0
      || !/^sha256:[a-f0-9]{64}$/.test(record.digest)
      || (previousPath !== undefined && record.path <= previousPath)) fail()
    previousPath = record.path
  }
  if (digestText('e2e-runtime-installation/v1', canonicalize(manifest.files))
    !== manifest.installationDigest) fail()
  const entryRecord = manifest.files.find((record) => record && record.path === configuration.entrypoint)
  if (!entryRecord
    || !Number.isSafeInteger(entryRecord.byteLength)
    || entryRecord.byteLength < 0
    || !/^sha256:[a-f0-9]{64}$/.test(entryRecord.digest)) fail()

  const entrypoint = join(versionRoot, ...configuration.entrypoint.split('/'))
  const entrypointRealpath = realpathSync(entrypoint)
  within(versionRoot, entrypointRealpath)
  const metadata = lstatSync(entrypoint)
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1
    || (metadata.mode & 0o077) !== 0
    || (typeof process.getuid === 'function' && metadata.uid !== process.getuid())) fail()
  const bytes = readFileSync(entrypoint)
  if (bytes.byteLength !== entryRecord.byteLength
    || digestBytes('e2e-runtime-file/v1', bytes) !== entryRecord.digest) fail()

  const environment = { ...process.env }
  delete environment.NODE_OPTIONS
  delete environment.NODE_PATH
  const child = spawn(process.execPath, [entrypoint, ...process.argv.slice(2)], {
    cwd: process.cwd(),
    env: environment,
    stdio: 'inherit',
  })
  child.once('error', fail)
  child.once('exit', (code, signal) => {
    if (signal) process.kill(process.pid, signal)
    else process.exit(code === null ? 70 : code)
  })
} catch {
  fail()
}

function readPrivateJson(path) {
  const metadata = lstatSync(path)
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1
    || (metadata.mode & 0o777) !== 0o600
    || (typeof process.getuid === 'function' && metadata.uid !== process.getuid())) fail()
  const value = JSON.parse(readFileSync(path, 'utf8'))
  if (typeof value !== 'object' || value === null || Array.isArray(value)) fail()
  return value
}

function privateDirectory(path) {
  const metadata = lstatSync(path)
  if (!metadata.isDirectory() || metadata.isSymbolicLink()
    || (metadata.mode & 0o777) !== 0o700
    || (typeof process.getuid === 'function' && metadata.uid !== process.getuid())) fail()
}

function exactKeys(value, expected) {
  const keys = Object.keys(value).sort()
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) fail()
}

function within(root, candidate) {
  const pathFromRoot = relative(root, candidate)
  if (pathFromRoot === '' || (!pathFromRoot.startsWith('..' + sep)
    && pathFromRoot !== '..' && !isAbsolute(pathFromRoot))) return
  fail()
}

function digestBytes(domain, bytes) {
  const prefix = Buffer.from('BIZTEST\\0' + domain + '\\0' + bytes.byteLength + '\\0', 'utf8')
  return 'sha256:' + createHash('sha256').update(prefix).update(bytes).digest('hex')
}

function digestText(domain, text) {
  const normalized = text.normalize('NFC').replace(/\\r\\n?/g, '\\n')
  return digestBytes(domain, Buffer.from(normalized, 'utf8'))
}

function canonicalize(value) {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value)
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value)
  if (Array.isArray(value)) return '[' + value.map(canonicalize).join(',') + ']'
  if (typeof value !== 'object' || value === null) fail()
  return '{' + Object.keys(value).sort()
    .map((key) => JSON.stringify(key) + ':' + canonicalize(value[key])).join(',') + '}'
}

function fail() {
  process.stderr.write('E2E_RUNTIME_LAUNCHER_INVALID\\n')
  process.exit(70)
}
`
}

function shellSingleQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`
}
