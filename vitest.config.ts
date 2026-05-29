import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    watch: false,
    // singleFork: the gated e2e test runs `DROP SCHEMA public CASCADE` against Postgres, so
    // integration tests must not run in parallel against the same DB. Mirrors the pipes-sdk.
    pool: 'forks',
    poolOptions: { forks: { isolate: false, singleFork: true } },
    testTimeout: 20_000,
    include: ['tests/**/*.test.ts'],
    coverage: { provider: 'v8', include: ['src'], reportsDirectory: './coverage' },
  },
})
