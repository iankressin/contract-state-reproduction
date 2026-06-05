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
      // Regression-guard floor, set just under the current achieved coverage
      // (stmts ~89.4 / branch ~89.8 / funcs ~91.7 / lines ~89.4). Do not raise above baseline.
      thresholds: { statements: 87, branches: 87, functions: 89, lines: 87 },
    },
  },
})
