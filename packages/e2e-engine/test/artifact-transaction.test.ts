import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { LocalArtifactStore } from '../src/index.js'
import { createArtifactStoreAuthority } from './artifact-store-authority.js'

const directories: string[] = []

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

describe('LocalArtifactStore', () => {
  test('prepares generation files with the fencing token that becomes active', async () => {
    const root = await mkdtemp(join(process.cwd(), '.tmp', 'e2e-artifacts-'))
    directories.push(root)
    const store = new LocalArtifactStore(root, createArtifactStoreAuthority())
    const preparedWith: number[] = []

    const active = await store.publishPrepared({
      assetId: 'PRODUCT-PRD-1',
      generationId: 'GENERATION-1',
      prepare: ({ fencingToken }) => {
        preparedWith.push(fencingToken)
        return {
          terminalVerdict: 'accepted',
          files: { 'run/fencing-token.json': `${JSON.stringify({ fencingToken })}\n` },
        }
      },
    })

    expect(preparedWith).toEqual([active.fencingToken])
    expect(JSON.parse(await readFile(
      join(active.generationPath, 'run/fencing-token.json'),
      'utf8',
    ))).toEqual({ fencingToken: active.fencingToken })
    expect(JSON.parse(await readFile(
      join(active.generationPath, '.publication-integrity.json'),
      'utf8',
    ))).toMatchObject({ fencingToken: active.fencingToken })
  })

  test('keeps the previous active generation when preparation throws', async () => {
    const root = await mkdtemp(join(process.cwd(), '.tmp', 'e2e-artifacts-'))
    directories.push(root)
    const store = new LocalArtifactStore(root, createArtifactStoreAuthority())
    await store.publish({
      assetId: 'PRODUCT-PRD-1',
      generationId: 'GENERATION-1',
      terminalVerdict: 'accepted',
      files: { 'run/report.md': '# generation 1\n' },
    })

    await expect(store.publishPrepared({
      assetId: 'PRODUCT-PRD-1',
      generationId: 'GENERATION-2',
      prepare: () => {
        throw new Error('generation preparation failed')
      },
    })).rejects.toThrow('generation preparation failed')

    const active = await store.readActive('PRODUCT-PRD-1')
    expect(active).toMatchObject({ generationId: 'GENERATION-1', terminalVerdict: 'accepted' })
    expect(await readFile(join(active!.generationPath, 'run/report.md'), 'utf8')).toBe('# generation 1\n')
  })

  test('can recover and retry a fresh asset when preparation throws', async () => {
    const root = await mkdtemp(join(process.cwd(), '.tmp', 'e2e-artifacts-'))
    directories.push(root)
    const store = new LocalArtifactStore(root, createArtifactStoreAuthority())

    await expect(store.publishPrepared({
      assetId: 'PRODUCT-PRD-1',
      generationId: 'GENERATION-1',
      prepare: () => {
        throw new Error('generation preparation failed')
      },
    })).rejects.toThrow('generation preparation failed')

    await expect(store.recover('PRODUCT-PRD-1')).resolves.toBeUndefined()
    await expect(store.publishPrepared({
      assetId: 'PRODUCT-PRD-1',
      generationId: 'GENERATION-2',
      prepare: ({ fencingToken }) => ({
        terminalVerdict: 'accepted',
        files: { 'run/fencing-token.txt': `${fencingToken}\n` },
      }),
    })).resolves.toMatchObject({ generationId: 'GENERATION-2' })
  })

  test('publishes requirements, regression, run, and report as one active generation', async () => {
    const root = await mkdtemp(join(process.cwd(), '.tmp', 'e2e-artifacts-'))
    directories.push(root)
    const store = new LocalArtifactStore(root, createArtifactStoreAuthority())

    await store.publish({
      assetId: 'PRODUCT-PRD-1',
      generationId: 'GENERATION-1',
      terminalVerdict: 'accepted',
      files: {
        'requirements/model.json': '{"model":1}\n',
        'regression/tests/read.spec.ts': 'test("read", () => {})\n',
        'run/results.json': '{"status":"passed"}\n',
        'run/report.md': '# accepted\n',
      },
    })

    const active = await store.readActive('PRODUCT-PRD-1')
    expect(active).toMatchObject({ generationId: 'GENERATION-1', terminalVerdict: 'accepted' })
    expect(await readFile(join(active!.generationPath, 'run/report.md'), 'utf8')).toBe('# accepted\n')
  })

  test('keeps the previous active generation when a crash occurs before pointer selection', async () => {
    const root = await mkdtemp(join(process.cwd(), '.tmp', 'e2e-artifacts-'))
    directories.push(root)
    const store = new LocalArtifactStore(root, createArtifactStoreAuthority())
    await store.publish({
      assetId: 'PRODUCT-PRD-1',
      generationId: 'GENERATION-1',
      terminalVerdict: 'accepted',
      files: { 'run/report.md': '# generation 1\n' },
    })

    await expect(store.publish({
      assetId: 'PRODUCT-PRD-1',
      generationId: 'GENERATION-2',
      terminalVerdict: 'rejected',
      files: { 'run/report.md': '# generation 2\n' },
      faultAt: 'after-generation-durable',
    })).rejects.toMatchObject({ code: 'E2E_ARTIFACT_FAULT_INJECTED' })

    const recovered = await store.recover('PRODUCT-PRD-1')
    expect(recovered).toMatchObject({ generationId: 'GENERATION-1', terminalVerdict: 'accepted' })
    expect(await readFile(join(recovered!.generationPath, 'run/report.md'), 'utf8')).toBe('# generation 1\n')
  })
})
