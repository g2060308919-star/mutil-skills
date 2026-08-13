import { readFile } from 'node:fs/promises'
import { describe, expect, test } from 'vitest'

describe('B2B proof workspace', () => {
  test('运行态 Artifact Store 使用单次临时目录，输出目录只保存可复算 proof', async () => {
    const source = await readFile(new URL('./e2e-b2b-coverage-proof.ts', import.meta.url), 'utf8')

    expect(source).toContain("mkdtemp(join(tmpdir(), 'mutil-e2e-b2b-artifacts-'))")
    expect(source).not.toContain("join(outputRoot, 'runtime-artifacts')")
    expect(source).toContain('rm(artifactRoot, { recursive: true, force: true })')
  })
})
