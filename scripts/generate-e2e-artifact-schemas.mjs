import { join } from 'node:path'
import { ARTIFACT_TYPES, generateArtifactJsonSchemas } from '../packages/e2e-contracts/dist/src/index.js'
import { writeArtifactSchemaSet } from './e2e-artifact-schema-writer.mjs'

const outputDirectory = join(process.cwd(), 'packages', 'e2e-contracts', 'schemas')
const schemas = generateArtifactJsonSchemas()
await writeArtifactSchemaSet({ outputDirectory, artifactTypes: ARTIFACT_TYPES, schemas })
