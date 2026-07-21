import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * 将完整 Schema registry 写成内容寻址集合，并原子更新 current.json。
 * 已发布的历史集合是可追踪测试资产，任何后续生成都不得删除它们。
 */
export async function writeArtifactSchemaSet({ outputDirectory, artifactTypes, schemas }) {
  if (Object.keys(schemas).length !== artifactTypes.length) {
    throw new Error('Artifact Schema registry 数量不一致')
  }

  const setsDirectory = join(outputDirectory, 'sets')
  await mkdir(setsDirectory, { recursive: true })
  const temporaryDirectory = await mkdtemp(join(setsDirectory, '.next-'))
  const expectedFiles = new Set(artifactTypes.map((type) => `${type}.schema.json`))
  const records = []

  try {
    for (const artifactType of artifactTypes) {
      const schema = schemas[artifactType]
      if (schema === undefined) throw new Error(`Artifact Schema 缺失：${artifactType}`)
      const file = `${artifactType}.schema.json`
      const content = `${JSON.stringify(schema, null, 2)}\n`
      await writeFile(join(temporaryDirectory, file), content, { encoding: 'utf8', mode: 0o600 })
      records.push({ file, digest: `sha256:${createHash('sha256').update(content).digest('hex')}` })
    }

    await writeFile(join(temporaryDirectory, 'schema-set.json'), `${JSON.stringify({
      schemaVersion: '1.0.0', artifactTypes, schemas: records,
    }, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })

    const generatedFiles = await readdir(temporaryDirectory)
    const generatedSchemaFiles = generatedFiles.filter((file) => file.endsWith('.schema.json'))
    if (generatedSchemaFiles.length !== expectedFiles.size
      || generatedSchemaFiles.some((file) => !expectedFiles.has(file))) {
      throw new Error('生成的 Artifact Schema 集不完整')
    }

    const setDigest = `sha256:${createHash('sha256').update(JSON.stringify(records)).digest('hex')}`
    const finalSetDirectory = join(setsDirectory, setDigest.slice('sha256:'.length))
    const setExists = await stat(finalSetDirectory).then(() => true, (error) => {
      if (error.code === 'ENOENT') return false
      throw error
    })
    if (setExists) {
      await validateExistingSet(finalSetDirectory, records, expectedFiles, artifactTypes)
      await rm(temporaryDirectory, { recursive: true, force: true })
    } else {
      await rename(temporaryDirectory, finalSetDirectory)
    }

    const pointer = `${JSON.stringify({
      schemaVersion: '1.0.0', setDigest,
      relativePath: `sets/${setDigest.slice('sha256:'.length)}/schema-set.json`,
    }, null, 2)}\n`
    const pointerNext = join(outputDirectory, 'current.json.next')
    await writeFile(pointerNext, pointer, { encoding: 'utf8', mode: 0o600 })
    await rename(pointerNext, join(outputDirectory, 'current.json'))

    // current.json 已原子指向完整集合后，才清理由旧生成器留下的根目录文件。
    for (const file of await readdir(outputDirectory)) {
      if (file.endsWith('.schema.json') || file === 'schema-set.json') {
        await rm(join(outputDirectory, file), { force: true })
      }
    }
    return { setDigest, relativePath: `sets/${setDigest.slice('sha256:'.length)}/schema-set.json` }
  } catch (error) {
    await rm(temporaryDirectory, { recursive: true, force: true })
    throw error
  }
}

async function validateExistingSet(directory, expectedRecords, expectedSchemaFiles, artifactTypes) {
  const files = await readdir(directory)
  const schemaFiles = files.filter((file) => file.endsWith('.schema.json'))
  if (schemaFiles.length !== expectedSchemaFiles.size
    || schemaFiles.some((file) => !expectedSchemaFiles.has(file))
    || !files.includes('schema-set.json')) {
    throw new Error(`已存在的 Schema 集不完整：${directory}`)
  }
  const manifest = JSON.parse(await readFile(join(directory, 'schema-set.json'), 'utf8'))
  if (JSON.stringify(manifest.schemas) !== JSON.stringify(expectedRecords)
    || JSON.stringify(manifest.artifactTypes) !== JSON.stringify(artifactTypes)) {
    throw new Error(`已存在的 Schema 集 manifest 不匹配：${directory}`)
  }
  for (const record of expectedRecords) {
    const content = await readFile(join(directory, record.file), 'utf8')
    const digest = `sha256:${createHash('sha256').update(content).digest('hex')}`
    if (digest !== record.digest) throw new Error(`已存在的 Schema 文件摘要错误：${record.file}`)
  }
}
