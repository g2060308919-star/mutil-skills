import { configDefaults, defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('.', import.meta.url))

export const aliases = {
  '@mutil-skills/hooks/cli': `${root}packages/hooks/src/runtime/cli.ts`,
  '@mutil-skills/hooks': `${root}packages/hooks/src/index.ts`,
  '@mutil-skills/core': `${root}packages/core/src/index.ts`,
  '@mutil-skills/schema': `${root}packages/schema/src/index.ts`,
  '@mutil-skills/template': `${root}packages/template/src/index.ts`,
  '@mutil-skills/foundation/testing': `${root}packages/foundation/src/testing/index.ts`,
  '@mutil-skills/skills': `${root}packages/skills/src/index.ts`,
  '@mutil-skills/e2e-contracts': `${root}packages/e2e-contracts/src/index.ts`,
  '@mutil-skills/e2e-engine': `${root}packages/e2e-engine/src/index.ts`,
  '@mutil-skills/e2e-authority': `${root}packages/e2e-authority/src/index.ts`,
  '@mutil-skills/e2e-gateway': `${root}packages/e2e-gateway/src/index.ts`,
  '@mutil-skills/e2e-playwright-runtime': `${root}packages/e2e-playwright-runtime/src/index.ts`,
  '@mutil-skills/e2e-report': `${root}packages/e2e-report/src/index.ts`,
  '@mutil-skills/e2e-runtime': `${root}packages/e2e-runtime/src/index.ts`,
}

export default defineConfig({
  resolve: {
    alias: aliases,
  },
  test: {
    globalSetup: ['./scripts/vitest-global-setup.ts'],
    include: ['packages/**/*.test.ts', 'scripts/**/*.test.ts'],
    exclude: [...configDefaults.exclude, 'scripts/**/*.golden.test.ts'],
    pool: 'forks',
  },
})
