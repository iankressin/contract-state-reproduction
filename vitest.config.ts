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
    coverage: {
      provider: 'v8',
      include: ['src'],
      reportsDirectory: './coverage',
      // Regression-guard floor, set just under the current baseline
      // (stmts ~83 / branch ~82 / funcs 82.69 / lines ~83). Do not raise above baseline.
      thresholds: { statements: 80, branches: 78, functions: 78, lines: 80 },
    },
  },
})
