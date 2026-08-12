import { pathToFileURL } from 'node:url'
import { scorePrdGoldBenchmark } from '../packages/e2e-engine/src/prd-gold-scorer.js'
import { canonicalizeJson, digestText } from '../packages/e2e-contracts/src/common.js'
import { prdGoldCorpus } from '../fixtures/e2e-prd-gold/corpus.js'

const GENERATOR_CONTEXT = {
  kind: 'checked-in-human-adjudicated-reference-candidate',
  corpusVersion: prdGoldCorpus.corpusVersion,
  policy: 'No model invocation; each candidate is the versioned reference projection checked into Git.',
}

export function runPrdGoldBenchmark(generatedAt = new Date().toISOString()) {
  return scorePrdGoldBenchmark(prdGoldCorpus, {
    generatorContextDigest: digestText('prd-gold-generator-context/v1', canonicalizeJson(GENERATOR_CONTEXT)),
    scorerVersion: '1.0.0',
    generatedAt,
  })
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.stdout.write(`${JSON.stringify(runPrdGoldBenchmark(), null, 2)}\n`)
}
