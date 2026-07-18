import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { writeArtifactSchemaSet } from './e2e-artifact-schema-writer.mjs'

describe('Artifact JSON Schema writer', () => {
  test('重复生成当前集合时保留所有历史内容寻址集合', async () => {
    const outputDirectory = await mkdtemp(join(tmpdir(), 'e2e-schema-writer-'))
    const historicalDirectory = join(outputDirectory, 'sets', 'historical-set')
    await mkdir(historicalDirectory, { recursive: true })
    await writeFile(join(historicalDirectory, 'schema-set.json'), '{"historical":true}\n')

    const input = {
      outputDirectory,
      artifactTypes: ['example'],
      schemas: {
        example: {
          $schema: 'https://json-schema.org/draft/2020-12/schema',
          type: 'object',
          additionalProperties: false,
        },
      },
    }
    const first = await writeArtifactSchemaSet(input)
    const second = await writeArtifactSchemaSet(input)

    expect(second).toEqual(first)
    expect(await readFile(join(historicalDirectory, 'schema-set.json'), 'utf8'))
      .toBe('{"historical":true}\n')
    expect(JSON.parse(await readFile(join(outputDirectory, 'current.json'), 'utf8')))
      .toMatchObject({ setDigest: first.setDigest })
  })
})
