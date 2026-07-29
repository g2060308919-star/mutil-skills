import { configDefaults, defineConfig } from 'vitest/config'
import { aliases } from './vitest.config.js'

export default defineConfig({
  resolve: { alias: aliases },
  test: {
    globalSetup: ['./scripts/vitest-global-setup.ts'],
    include: ['scripts/**/*.golden.test.ts'],
    exclude: configDefaults.exclude,
    pool: 'forks',
  },
})
