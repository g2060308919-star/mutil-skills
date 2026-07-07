import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('.', import.meta.url))

export default defineConfig({
  resolve: {
    alias: {
      '@mutil-skills/core': `${root}packages/core/src/index.ts`,
      '@mutil-skills/schema': `${root}packages/schema/src/index.ts`,
      '@mutil-skills/template': `${root}packages/template/src/index.ts`,
      '@mutil-skills/foundation/testing': `${root}packages/foundation/src/testing/index.ts`,
      '@mutil-skills/skills': `${root}packages/skills/src/index.ts`,
    },
  },
  test: {
    include: ['packages/**/*.test.ts', 'scripts/**/*.test.ts'],
    pool: 'forks',
  },
})
