import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
// This build-only module intentionally remains outside the Runtime package exports.
import { copyApprovalAssets } from '../scripts/copy-approval-assets.mjs'

const expectedBundleDigest = 'cf4469953efcb5617a870ae3f022b3ad48aee8c06012ccdafcabc73058f123a0'

test('copies only the pinned SimpleWebAuthn browser bundle and verifies its digest', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'e2e-approval-assets-'))
  const source = join(directory, 'browser')
  const target = join(directory, 'assets')
  try {
    await mkdir(join(source, 'dist/bundle'), { recursive: true })
    await writeFile(join(source, 'package.json'), JSON.stringify({ name: '@simplewebauthn/browser', version: '13.3.0' }))
    const realBundle = await readFile('node_modules/@simplewebauthn/browser/dist/bundle/index.umd.min.js')
    await writeFile(join(source, 'dist/bundle/index.umd.min.js'), realBundle)
    await expect(copyApprovalAssets({ sourcePackageRoot: source, targetRoot: target })).resolves.toEqual({
      version: '13.3.0', sourceDigest: expectedBundleDigest, targetDigest: expectedBundleDigest,
    })
    expect(await readFile(join(target, 'simplewebauthn-browser.js'))).toEqual(realBundle)
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('fails closed for manifest, source digest, symlink, and existing target drift', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'e2e-approval-assets-drift-'))
  const source = join(directory, 'browser')
  const target = join(directory, 'assets')
  try {
    await mkdir(join(source, 'dist/bundle'), { recursive: true })
    await writeFile(join(source, 'package.json'), JSON.stringify({ name: '@simplewebauthn/browser', version: '13.3.1' }))
    await writeFile(join(source, 'dist/bundle/index.umd.min.js'), 'drift')
    await expect(copyApprovalAssets({ sourcePackageRoot: source, targetRoot: target }))
      .rejects.toThrow(/E2E_APPROVAL_ASSET_VERSION_MISMATCH/)
    await writeFile(join(source, 'package.json'), JSON.stringify({ name: '@simplewebauthn/browser', version: '13.3.0' }))
    await expect(copyApprovalAssets({ sourcePackageRoot: source, targetRoot: target }))
      .rejects.toThrow(/E2E_APPROVAL_ASSET_SOURCE_DIGEST_MISMATCH/)

    const installed = 'node_modules/@simplewebauthn/browser/dist/bundle/index.umd.min.js'
    await rm(join(source, 'dist/bundle/index.umd.min.js'))
    await symlink(join(process.cwd(), installed), join(source, 'dist/bundle/index.umd.min.js'))
    await expect(copyApprovalAssets({ sourcePackageRoot: source, targetRoot: target }))
      .rejects.toThrow(/E2E_APPROVAL_ASSET_SOURCE_REALPATH_INVALID/)

    await rm(join(source, 'dist/bundle/index.umd.min.js'))
    await writeFile(join(source, 'dist/bundle/index.umd.min.js'), await readFile(installed))
    await mkdir(target, { recursive: true })
    await writeFile(join(target, 'simplewebauthn-browser.js'), 'tampered')
    await expect(copyApprovalAssets({ sourcePackageRoot: source, targetRoot: target }))
      .rejects.toThrow(/E2E_APPROVAL_ASSET_TARGET_DRIFT/)
  } finally { await rm(directory, { recursive: true, force: true }) }
})
