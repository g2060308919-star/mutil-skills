import { canonicalizeJson, digestText } from '@mutil-skills/e2e-contracts'
import { link, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import {
  createCompletePublicationAuditor,
  LocalArtifactStore,
  PatternPrivacyScanner,
  SafeAssetSession,
} from '../src/index.js'
import { createArtifactStoreAuthority } from './artifact-store-authority.js'

const directories: string[] = []

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

async function createStore(): Promise<{ root: string; store: LocalArtifactStore }> {
  const root = await mkdtemp(join(process.cwd(), '.tmp', 'e2e-recovery-'))
  directories.push(root)
  return { root, store: new LocalArtifactStore(root, createArtifactStoreAuthority()) }
}

async function publish(store: LocalArtifactStore, generationId: string, faultAt?: string): Promise<void> {
  await store.publish({
    assetId: 'PRODUCT-PRD-1', generationId, terminalVerdict: 'accepted',
    files: { 'run/report.md': `# ${generationId}\n` }, faultAt: faultAt as never,
  })
}

describe('Artifact kill-point 与恢复矩阵', () => {
  test('指针选择前的所有 durable kill point 保留旧 active；选择后恢复新 active', async () => {
    const beforeSelection = [
      'after-journal-preparing', 'after-staging-durable',
      'after-generation-durable', 'after-pointer-written',
    ]
    for (const faultAt of beforeSelection) {
      const { root, store } = await createStore()
      await publish(store, 'GENERATION-1')
      await expect(publish(store, 'GENERATION-2', faultAt)).rejects.toMatchObject({
        code: 'E2E_ARTIFACT_FAULT_INJECTED',
      })
      await expect(store.recover('PRODUCT-PRD-1')).resolves.toMatchObject({ generationId: 'GENERATION-1' })
    }

    for (const faultAt of ['after-pointer-selected', 'after-journal-committed']) {
      const { store } = await createStore()
      await publish(store, 'GENERATION-1')
      await expect(publish(store, 'GENERATION-2', faultAt)).rejects.toMatchObject({
        code: 'E2E_ARTIFACT_FAULT_INJECTED',
      })
      await expect(store.recover('PRODUCT-PRD-1')).resolves.toMatchObject({ generationId: 'GENERATION-2' })
    }
  })

  test('journal 使用固定字段、合法 phase 和可独立复算的 checksum', async () => {
    const { root, store } = await createStore()
    await publish(store, 'GENERATION-1')
    const journalPath = join(root, '.biztest', 'assets', 'PRODUCT-PRD-1', 'journal.json')
    const journal = JSON.parse(await readFile(journalPath, 'utf8')) as Record<string, unknown>

    expect(Object.keys(journal).sort()).toEqual([
      'checksum', 'fencingToken', 'generationDigest', 'generationId', 'phase',
      'previousActive', 'startedAt', 'targetSlot', 'transactionId', 'updatedAt',
    ].sort())
    expect(journal.phase).toBe('committed')
    const { checksum, ...payload } = journal
    expect(checksum).toBe(digestText('artifact-journal/v1', canonicalizeJson(payload)))
  })

  test('active 已选择但 journal 未提交时，恢复会补记 committed', async () => {
    const { root, store } = await createStore()
    await publish(store, 'GENERATION-1')
    await expect(publish(store, 'GENERATION-2', 'after-pointer-selected')).rejects.toMatchObject({
      code: 'E2E_ARTIFACT_FAULT_INJECTED',
    })
    await expect(store.recover('PRODUCT-PRD-1')).resolves.toMatchObject({ generationId: 'GENERATION-2' })
    const journal = JSON.parse(await readFile(
      join(root, '.biztest', 'assets', 'PRODUCT-PRD-1', 'journal.json'), 'utf8',
    )) as { phase: string }
    expect(journal.phase).toBe('committed')
  })

  test('所选 generation 损坏时依次回退另一槽和 previous generation', async () => {
    const { root, store } = await createStore()
    await publish(store, 'GENERATION-1')
    await expect(publish(store, 'GENERATION-2', 'after-journal-committed')).rejects.toMatchObject({
      code: 'E2E_ARTIFACT_FAULT_INJECTED',
    })
    const assetRoot = join(root, '.biztest', 'assets', 'PRODUCT-PRD-1')
    await writeFile(join(assetRoot, 'generations', 'GENERATION-2', '.publication-integrity.json'), '{}\n')

    await expect(store.recover('PRODUCT-PRD-1')).resolves.toMatchObject({ generationId: 'GENERATION-1' })
    await rm(join(assetRoot, 'active-a.json'))
    await expect(store.recover('PRODUCT-PRD-1')).resolves.toMatchObject({ generationId: 'GENERATION-1' })
  })

  test('存在发布状态但双槽和 previous 均不可靠时返回 artifact-blocked', async () => {
    const { root, store } = await createStore()
    await publish(store, 'GENERATION-1')
    const assetRoot = join(root, '.biztest', 'assets', 'PRODUCT-PRD-1')
    await writeFile(join(assetRoot, 'active-a.json'), '{torn')
    await writeFile(join(assetRoot, 'active-b.json'), '{torn')
    await expect(store.recover('PRODUCT-PRD-1')).rejects.toMatchObject({
      code: 'E2E_ARTIFACT_NO_RELIABLE_GENERATION', category: 'artifact',
    })
  })

  test('拒绝 generations 符号链接竞争，且不会写入工作区外目录', async () => {
    const { root, store } = await createStore()
    const outside = await mkdtemp(join(process.cwd(), '.tmp', 'e2e-outside-'))
    directories.push(outside)
    const assetRoot = join(root, '.biztest', 'assets', 'PRODUCT-PRD-1')
    await mkdir(assetRoot, { recursive: true })
    await symlink(outside, join(assetRoot, 'generations'))

    await expect(publish(store, 'GENERATION-1')).rejects.toMatchObject({
      code: 'E2E_ARTIFACT_PATH_UNSAFE', category: 'artifact',
    })
    await expect(readFile(join(outside, 'GENERATION-1', 'run', 'report.md'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  test('OS advisory lock 拒绝并发 session，并在持有进程退出后自动释放', async () => {
    const { root } = await createStore()
    const assetRoot = join(root, '.biztest', 'assets', 'PRODUCT-PRD-1')
    const first = await SafeAssetSession.acquire(assetRoot)
    await expect(SafeAssetSession.acquire(assetRoot)).rejects.toMatchObject({ code: 'E2E_ARTIFACT_LOCKED' })
    await first.close()
    const afterExit = await SafeAssetSession.acquire(assetRoot)
    await afterExit.close()
  })

  test('磁盘满和权限失败写 aborted，且旧 active 与 fencing token 单调性不受破坏', async () => {
    for (const [faultAt, code] of [
      ['disk-full-during-files', 'E2E_ARTIFACT_DISK_FULL'],
      ['permission-denied-before-manifest', 'E2E_ARTIFACT_PERMISSION_DENIED'],
    ] as const) {
      const { root, store } = await createStore()
      await publish(store, 'GENERATION-1')
      await expect(publish(store, 'GENERATION-2', faultAt)).rejects.toMatchObject({ code })
      const assetRoot = join(root, '.biztest', 'assets', 'PRODUCT-PRD-1')
      const journal = JSON.parse(await readFile(join(assetRoot, 'journal.json'), 'utf8')) as { phase: string }
      expect(journal.phase).toBe('aborted')
      await expect(store.recover('PRODUCT-PRD-1')).resolves.toMatchObject({ generationId: 'GENERATION-1' })
      await publish(store, 'GENERATION-3')
      const active = await store.readActive('PRODUCT-PRD-1')
      expect(active).toMatchObject({ generationId: 'GENERATION-3', fencingToken: 4 })
    }
  })

  test('helper 内部每个 file/rename/fsync kill point 都只恢复完整 active，并自动释放锁', async () => {
    const oldActiveFaults = [
      'crash-after-file-fsync', 'crash-after-file-parent-fsync',
      'crash-after-manifest-fsync', 'crash-after-manifest-parent-fsync',
      'crash-after-staging-fsync', 'crash-after-generation-rename',
      'crash-after-generations-fsync', 'crash-after-pointer-temp-fsync',
      'crash-after-pointer-rename', 'crash-after-pointer-parent-fsync',
      'crash-after-selector-temp-fsync',
    ]
    for (const faultAt of oldActiveFaults) {
      const { store } = await createStore()
      await publish(store, 'GENERATION-1')
      await expect(publish(store, 'GENERATION-2', faultAt)).rejects.toMatchObject({
        code: 'E2E_ARTIFACT_FAULT_INJECTED',
      })
      await expect(store.recover('PRODUCT-PRD-1')).resolves.toMatchObject({ generationId: 'GENERATION-1' })
    }
    for (const faultAt of ['crash-after-selector-rename', 'crash-after-selector-parent-fsync']) {
      const { root, store } = await createStore()
      await publish(store, 'GENERATION-1')
      await expect(publish(store, 'GENERATION-2', faultAt)).rejects.toMatchObject({
        code: 'E2E_ARTIFACT_FAULT_INJECTED',
      })
      await expect(store.recover('PRODUCT-PRD-1')).resolves.toMatchObject({ generationId: 'GENERATION-2' })
      const journal = JSON.parse(await readFile(
        join(root, '.biztest', 'assets', 'PRODUCT-PRD-1', 'journal.json'), 'utf8',
      )) as { phase: string }
      expect(journal.phase).toBe('committed')
      await publish(store, 'GENERATION-3')
    }
  })

  test('fencing 与每次 publish journal 原子写的 temp/fsync/rename kill-point 均可恢复', async () => {
    const stages = ['temp-fsync', 'rename', 'parent-fsync']
    const oldActiveTargets = [
      'fencing', 'journal-preparing', 'journal-staged', 'journal-generation-durable',
      'journal-pointer-written', 'journal-aborted',
    ]
    for (const target of oldActiveTargets) {
      for (const stage of stages) {
        const { store } = await createStore()
        await publish(store, 'GENERATION-1')
        const faultAt = `crash-after-${target}-${stage}`
        await expect(publish(store, 'GENERATION-2', faultAt)).rejects.toMatchObject({
          code: 'E2E_ARTIFACT_FAULT_INJECTED',
        })
        await expect(store.recover('PRODUCT-PRD-1')).resolves.toMatchObject({ generationId: 'GENERATION-1' })
      }
    }
    for (const target of ['journal-pointer-selected', 'journal-committed']) {
      for (const stage of stages) {
        const { store } = await createStore()
        await publish(store, 'GENERATION-1')
        await expect(publish(store, 'GENERATION-2', `crash-after-${target}-${stage}`)).rejects.toMatchObject({
          code: 'E2E_ARTIFACT_FAULT_INJECTED',
        })
        await expect(store.recover('PRODUCT-PRD-1')).resolves.toMatchObject({ generationId: 'GENERATION-2' })
      }
    }
  })

  test('成功提交后 GC 收敛为唯一 latest generation', async () => {
    const { root, store } = await createStore()
    await publish(store, 'GENERATION-1')
    await publish(store, 'GENERATION-2')
    const generations = join(root, '.biztest', 'assets', 'PRODUCT-PRD-1', 'generations')
    await expect(readdir(generations)).resolves.toEqual(['GENERATION-2'])
  })

  test('独立 GC 删除 orphan/staging，但保留 active 与正在 validation 的 generation', async () => {
    const { root, store } = await createStore()
    await publish(store, 'GENERATION-1')
    await expect(publish(store, 'GENERATION-2', 'after-generation-durable')).rejects.toMatchObject({
      code: 'E2E_ARTIFACT_FAULT_INJECTED',
    })
    await store.gc('PRODUCT-PRD-1', ['GENERATION-2'])
    const generations = join(root, '.biztest', 'assets', 'PRODUCT-PRD-1', 'generations')
    await expect(readdir(generations)).resolves.toEqual(['GENERATION-1', 'GENERATION-2'])
    await store.recover('PRODUCT-PRD-1')
    await expect(readdir(generations)).resolves.toEqual(['GENERATION-1', 'GENERATION-2'])
    await store.gc('PRODUCT-PRD-1')
    await expect(readdir(generations)).resolves.toEqual(['GENERATION-1'])
  })

  test('GC 在 slot normalization、journal 和 delete/fsync 崩溃后仍可幂等收敛', async () => {
    for (const faultAt of [
      'after-gc-first-slot', 'after-gc-journal-committed', 'crash-during-gc-delete',
    ]) {
      const { root, store } = await createStore()
      await publish(store, 'GENERATION-1')
      await expect(publish(store, 'GENERATION-2', 'after-journal-committed')).rejects.toMatchObject({
        code: 'E2E_ARTIFACT_FAULT_INJECTED',
      })
      await expect(store.gc('PRODUCT-PRD-1', [], faultAt as never)).rejects.toMatchObject({
        code: 'E2E_ARTIFACT_FAULT_INJECTED',
      })
      await expect(store.recover('PRODUCT-PRD-1')).resolves.toMatchObject({ generationId: 'GENERATION-2' })
      await store.gc('PRODUCT-PRD-1')
      await expect(readdir(join(
        root, '.biztest', 'assets', 'PRODUCT-PRD-1', 'generations',
      ))).resolves.toEqual(['GENERATION-2'])
    }
  })

  test('GC 每次 pointer、selector、journal 原子写的 kill-point 均幂等恢复', async () => {
    const targets = [
      'fencing', 'validation-refs', 'gc-journal-preparing', 'gc-active-a', 'gc-active-b', 'gc-selector',
      'gc-journal-committed', 'gc-delete-journal-preparing', 'gc-delete-journal-committed',
    ]
    for (const target of targets) {
      for (const stage of ['temp-fsync', 'rename', 'parent-fsync']) {
        const { root, store } = await createStore()
        await publish(store, 'GENERATION-1')
        await expect(publish(store, 'GENERATION-2', 'after-journal-committed')).rejects.toMatchObject({
          code: 'E2E_ARTIFACT_FAULT_INJECTED',
        })
        await expect(store.gc('PRODUCT-PRD-1', [], `crash-after-${target}-${stage}` as never)).rejects.toMatchObject({
          code: 'E2E_ARTIFACT_FAULT_INJECTED',
        })
        await expect(store.recover('PRODUCT-PRD-1')).resolves.toMatchObject({ generationId: 'GENERATION-2' })
        await store.gc('PRODUCT-PRD-1')
        await expect(readdir(join(
          root, '.biztest', 'assets', 'PRODUCT-PRD-1', 'generations',
        ))).resolves.toEqual(['GENERATION-2'])
      }
    }
  }, 20_000)

  test('篡改 pointer 或 manifest 后 Authority 验签失败，不能成为 active', async () => {
    const { root, store } = await createStore()
    await publish(store, 'GENERATION-1')
    const assetRoot = join(root, '.biztest', 'assets', 'PRODUCT-PRD-1')
    for (const slot of ['a', 'b']) {
      const path = join(assetRoot, `active-${slot}.json`)
      const pointer = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>
      await writeFile(path, `${JSON.stringify({ ...pointer, terminalVerdict: 'rejected' })}\n`)
    }
    await expect(store.recover('PRODUCT-PRD-1')).rejects.toMatchObject({
      code: 'E2E_ARTIFACT_NO_RELIABLE_GENERATION',
    })

    const fresh = await createStore()
    await publish(fresh.store, 'GENERATION-1')
    const manifestPath = join(
      fresh.root, '.biztest', 'assets', 'PRODUCT-PRD-1', 'generations', 'GENERATION-1', '.publication-integrity.json',
    )
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as Record<string, unknown>
    await writeFile(manifestPath, `${JSON.stringify({ ...manifest, terminalVerdict: 'rejected' })}\n`)
    await expect(fresh.store.recover('PRODUCT-PRD-1')).rejects.toMatchObject({
      code: 'E2E_ARTIFACT_NO_RELIABLE_GENERATION',
    })

    const extra = await createStore()
    await publish(extra.store, 'GENERATION-1')
    await writeFile(join(
      extra.root, '.biztest', 'assets', 'PRODUCT-PRD-1', 'generations', 'GENERATION-1', 'unregistered.txt',
    ), 'unexpected')
    await expect(extra.store.recover('PRODUCT-PRD-1')).rejects.toMatchObject({
      code: 'E2E_ARTIFACT_NO_RELIABLE_GENERATION',
    })
  })

  test('recover 在同一 advisory lock 内清除未验证 staging 和撕裂 journal', async () => {
    const { root, store } = await createStore()
    await publish(store, 'GENERATION-1')
    await expect(publish(store, 'GENERATION-2', 'after-staging-durable')).rejects.toMatchObject({
      code: 'E2E_ARTIFACT_FAULT_INJECTED',
    })
    const assetRoot = join(root, '.biztest', 'assets', 'PRODUCT-PRD-1')
    await writeFile(join(assetRoot, 'journal.json'), '{torn')
    await expect(store.recover('PRODUCT-PRD-1')).resolves.toMatchObject({ generationId: 'GENERATION-1' })
    await expect(readdir(join(assetRoot, 'generations'))).resolves.toEqual(['GENERATION-1'])
  })

  test('拒绝 generation 内硬链接，且 Python runtime 缺失时明确 fail-closed', async () => {
    const { root, store } = await createStore()
    await publish(store, 'GENERATION-1')
    const outside = join(root, 'outside-report.md')
    await writeFile(outside, '# GENERATION-1\n')
    const report = join(
      root, '.biztest', 'assets', 'PRODUCT-PRD-1', 'generations', 'GENERATION-1', 'run', 'report.md',
    )
    await rm(report)
    await link(outside, report)
    await expect(store.recover('PRODUCT-PRD-1')).rejects.toMatchObject({
      code: 'E2E_ARTIFACT_NO_RELIABLE_GENERATION',
    })

    await expect(SafeAssetSession.acquire(
      join(root, '.biztest', 'assets', 'MISSING-RUNTIME'), '/definitely/missing/python3',
    )).rejects.toMatchObject({ code: 'E2E_ARTIFACT_HELPER_START_FAILED' })
  })

  test('fencing counter 损坏或已有状态无可靠 active 时禁止继续发布', async () => {
    const corruptedCounter = await createStore()
    await publish(corruptedCounter.store, 'GENERATION-1')
    const counterRoot = join(corruptedCounter.root, '.biztest', 'assets', 'PRODUCT-PRD-1')
    await writeFile(join(counterRoot, 'fencing-counter'), 'not-a-number\n')
    await expect(publish(corruptedCounter.store, 'GENERATION-2')).rejects.toMatchObject({
      code: 'E2E_ARTIFACT_FENCING_COUNTER_INVALID',
    })

    const unreliable = await createStore()
    await publish(unreliable.store, 'GENERATION-1')
    const unreliableRoot = join(unreliable.root, '.biztest', 'assets', 'PRODUCT-PRD-1')
    await writeFile(join(unreliableRoot, 'active-a.json'), '{torn')
    await writeFile(join(unreliableRoot, 'active-b.json'), '{torn')
    await expect(publish(unreliable.store, 'GENERATION-2')).rejects.toMatchObject({
      code: 'E2E_ARTIFACT_NO_RELIABLE_GENERATION',
    })

    const stale = await createStore()
    await publish(stale.store, 'GENERATION-1')
    await publish(stale.store, 'GENERATION-2')
    const staleRoot = join(stale.root, '.biztest', 'assets', 'PRODUCT-PRD-1')
    await writeFile(join(staleRoot, 'fencing-counter'), '1\n')
    await expect(publish(stale.store, 'GENERATION-3')).rejects.toMatchObject({
      code: 'E2E_ARTIFACT_FENCING_COUNTER_INVALID',
    })

    const overtaken = await createStore()
    await publish(overtaken.store, 'GENERATION-1')
    await expect(publish(overtaken.store, 'GENERATION-2', 'tamper-fencing-before-pointer')).rejects.toMatchObject({
      code: 'E2E_ARTIFACT_STALE_WRITER',
    })
    await expect(overtaken.store.recover('PRODUCT-PRD-1')).resolves.toMatchObject({ generationId: 'GENERATION-1' })

    const selectorWindow = await createStore()
    await publish(selectorWindow.store, 'GENERATION-1')
    await expect(publish(
      selectorWindow.store, 'GENERATION-2', 'tamper-fencing-before-selector',
    )).rejects.toMatchObject({ code: 'E2E_ARTIFACT_STALE_WRITER' })
    await expect(selectorWindow.store.recover('PRODUCT-PRD-1')).resolves.toMatchObject({
      generationId: 'GENERATION-1',
    })
  })

  test('GC 删除前重读签名引用；引用竞态时停止删除并保留 orphan', async () => {
    const { root, store } = await createStore()
    await publish(store, 'GENERATION-1')
    await expect(publish(store, 'GENERATION-2', 'after-journal-committed')).rejects.toMatchObject({
      code: 'E2E_ARTIFACT_FAULT_INJECTED',
    })
    await expect(store.gc('PRODUCT-PRD-1', [], 'tamper-gc-reference-before-delete')).rejects.toMatchObject({
      code: 'E2E_ARTIFACT_GC_REFERENCE_CHANGED',
    })
    await expect(readdir(join(
      root, '.biztest', 'assets', 'PRODUCT-PRD-1', 'generations',
    ))).resolves.toEqual(['GENERATION-1', 'GENERATION-2'])
    await expect(store.recover('PRODUCT-PRD-1')).resolves.toMatchObject({ generationId: 'GENERATION-2' })
  })

  test('Authority staging 审计是签名发布前强制门禁，并拒绝未登记文件', async () => {
    const root = await mkdtemp(join(process.cwd(), '.tmp', 'e2e-audit-gate-'))
    directories.push(root)
    const authority = createArtifactStoreAuthority()
    const rejected = new LocalArtifactStore(root, {
      ...authority,
      auditStagedGeneration: async () => { throw new Error('schema audit rejected') },
    })
    await expect(publish(rejected, 'GENERATION-1')).rejects.toThrow('schema audit rejected')

    const closureRoot = await mkdtemp(join(process.cwd(), '.tmp', 'e2e-file-closure-'))
    directories.push(closureRoot)
    const closureStore = new LocalArtifactStore(closureRoot, {
      ...authority,
      auditStagedGeneration: async (input) => {
        await writeFile(join(input.stagingPath, 'unregistered.txt'), 'secret')
      },
    })
    await expect(publish(closureStore, 'GENERATION-1')).rejects.toMatchObject({
      code: 'E2E_ARTIFACT_FILE_CLOSURE_INVALID',
    })

    const completeRoot = await mkdtemp(join(process.cwd(), '.tmp', 'e2e-complete-audit-'))
    directories.push(completeRoot)
    const completeStore = new LocalArtifactStore(completeRoot, {
      ...authority,
      auditStagedGeneration: createCompletePublicationAuditor({
        scanner: new PatternPrivacyScanner('1.0.0'),
        resolveValidationInput: () => ({
          artifactPaths: {
            'FINAL-REPORT': 'run/report.md',
            'GENERATION-MANIFEST': 'generation-manifest.json',
          },
        }),
      }),
    })
    await expect(publish(completeStore, 'GENERATION-1')).rejects.toMatchObject({
      code: 'E2E_PUBLICATION_ARTIFACT_JSON_INVALID',
    })
  })

  test('二进制 evidence 按原始 bytes 写入并校验，不经过文本转码', async () => {
    const { store } = await createStore()
    const bytes = Uint8Array.from([0, 255, 1, 254, 2, 253])
    await store.publish({
      assetId: 'PRODUCT-PRD-1', generationId: 'GENERATION-1', terminalVerdict: 'accepted',
      files: { 'evidence/screenshot.png': bytes },
    })
    const active = await store.readActive('PRODUCT-PRD-1')
    await expect(readFile(join(active!.generationPath, 'evidence', 'screenshot.png'))).resolves.toEqual(Buffer.from(bytes))
  })
})
