import { configDefaults, defineConfig } from 'vitest/config'
import { aliases } from './vitest.config.js'

export default defineConfig({
  resolve: { alias: aliases },
  test: {
    include: ['scripts/**/*.golden.test.ts'],
    exclude: configDefaults.exclude,
    pool: 'forks',
  },
})
