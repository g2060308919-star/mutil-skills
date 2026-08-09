import { afterEach, describe, expect, test } from 'vitest'
import { link, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { E2EInputPreparer } from '../src/e2e-input-preparer.js'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true })))
})

describe('E2EInputPreparer', () => {
  test('把 URL 快照、契约和 policy 自动封装为幂等的 Runtime create payload', async () => {
    const root = await mkdtemp(join('.tmp', 'e2e-input-preparer-'))
    roots.push(root)
    const preparer = new E2EInputPreparer(root)
    const draft = { ...inputDraft(), runtimePolicy: { mode: 'pinned' as const, version: '0.7.0',
      installationDigest: `sha256:${'a'.repeat(64)}` } }

    const first = await preparer.prepare(draft)
    const second = await preparer.prepare(draft)

    expect(second).toEqual(first)
    expect(first.create).toMatchObject({
      assetId: 'COOPER',
      prdSource: { kind: 'file', origin: { kind: 'url', ref: 'https://example.test/cooper-prd' } },
      understandingContract: { header: draft.understandingContract.header,
        source: { kind: 'file' } },
      supportingSources: [{ sourceId: 'RULES', relevance: 'necessary-dependency' }],
      runtimePolicy: draft.runtimePolicy,
    })
    for (const path of [
      first.create.prdSource.path,
      first.create.understandingContract.source.path,
      first.create.projectPolicyPath,
      first.create.supportingSources![0]!.path,
      '.biztest/project.json',
    ]) {
      expect(path.startsWith('/')).toBe(false)
      expect((await lstat(join(root, path))).mode & 0o777).toBe(0o600)
    }
    expect(await readFile(join(root, first.create.prdSource.path), 'utf8')).toBe('# Cooper PRD\n')
  })

  test('拒绝把 assetId 当作路径导航段', async () => {
    const root = await mkdtemp(join('.tmp', 'e2e-input-preparer-path-'))
    roots.push(root)
    await expect(new E2EInputPreparer(root).prepare({ ...inputDraft(), assetId: '..' }))
      .rejects.toMatchObject({ name: 'ZodError' })
  })

  test('拒绝已有 intake 文件中的符号链接和内容冲突', async () => {
    const root = await mkdtemp(join('.tmp', 'e2e-input-preparer-symlink-'))
    roots.push(root)
    const preparer = new E2EInputPreparer(root)
    const prepared = await preparer.prepare(inputDraft())
    const prdPath = join(root, prepared.create.prdSource.path)
    await rm(prdPath)
    await symlink(join(root, '.biztest', 'project.json'), prdPath)
    await expect(preparer.prepare(inputDraft())).rejects.toMatchObject({
      code: 'E2E_INPUT_SNAPSHOT_CONFLICT',
    })

    await rm(prdPath)
    await writeFile(prdPath, 'tampered', { mode: 0o600 })
    await expect(preparer.prepare(inputDraft())).rejects.toMatchObject({
      code: 'E2E_INPUT_SNAPSHOT_CONFLICT',
    })

    await rm(prdPath)
    const outsideFile = join(root, 'outside.txt')
    await writeFile(outsideFile, '# Cooper PRD\n', { mode: 0o600 })
    await link(outsideFile, prdPath)
    await expect(preparer.prepare(inputDraft())).rejects.toMatchObject({
      code: 'E2E_INPUT_SNAPSHOT_CONFLICT',
    })
  })

  test('拒绝符号链接形式的 .biztest 接入目录', async () => {
    const root = await mkdtemp(join('.tmp', 'e2e-input-preparer-root-'))
    const outside = await mkdtemp(join('.tmp', 'e2e-input-preparer-outside-'))
    roots.push(root, outside)
    await mkdir(join(outside, 'target'))
    await symlink(join(outside, 'target'), join(root, '.biztest'))
    await expect(new E2EInputPreparer(root).prepare(inputDraft())).rejects.toMatchObject({
      code: 'E2E_INPUT_PATH_UNSAFE',
    })
  })

  test('拒绝符号链接形式的项目根，并在写入前结束', async () => {
    const root = await mkdtemp(join('.tmp', 'e2e-input-preparer-real-root-'))
    const alias = `${root}-alias`
    roots.push(alias, root)
    await symlink(resolve(root), alias)
    await expect(new E2EInputPreparer(alias).prepare(inputDraft())).rejects.toMatchObject({
      code: 'E2E_RUNTIME_PROJECT_SYMLINK_FORBIDDEN',
    })
  })

  test('只读复用已有 project policy，并让 policy 变化产生新 intake', async () => {
    const root = await mkdtemp(join('.tmp', 'e2e-input-preparer-policy-'))
    roots.push(root)
    await mkdir(join(root, '.biztest'))
    const policyPath = join(root, '.biztest', 'project-policy.json')
    await writeFile(policyPath, '{"policyVersion":"1.0.0"}\n', { mode: 0o600 })
    const preparer = new E2EInputPreparer(root)

    const first = await preparer.prepare(inputDraft())
    expect(await readFile(join(root, first.create.projectPolicyPath), 'utf8'))
      .toBe('{"policyVersion":"1.0.0"}\n')
    await writeFile(policyPath, '{"policyVersion":"1.0.1"}\n', { mode: 0o600 })
    const second = await preparer.prepare(inputDraft())
    expect(second.intakeId).not.toBe(first.intakeId)
    expect(await readFile(join(root, second.create.projectPolicyPath), 'utf8'))
      .toBe('{"policyVersion":"1.0.1"}\n')
  })
})

function inputDraft() {
  return {
    schemaVersion: '1.0.0' as const,
    assetId: 'COOPER',
    prd: { text: '# Cooper PRD\n', origin: {
      kind: 'url' as const, ref: 'https://example.test/cooper-prd',
    } },
    understandingContract: {
      text: '# Cooper requirements contract\n',
      header: {
        schemaVersion: '1.0.0' as const, contractId: 'COOPER-CONTRACT', contractVersion: 1,
        contractStatus: 'confirmed-by-caller' as const,
        authorization: { status: 'confirmed-by-caller' as const, contractVersion: 1,
          confirmedAt: '2026-08-03T00:00:00.000Z' },
      },
    },
    supportingSources: [{ sourceId: 'RULES', text: '仅验证预览。', mediaType: 'text/plain',
      origin: { kind: 'text' as const, ref: 'caller-context' } }],
  }
}
