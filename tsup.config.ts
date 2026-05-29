import { defineConfig } from 'tsup'

// Bundling (not tsc-emit) is deliberate: internal imports use explicit `.ts` extensions
// (e.g. `from './config.ts'`). esbuild inlines those modules into a single dist/index.js,
// so no `./*.ts` specifiers survive in the JS or in the bundled .d.ts — only the external
// bare package specifiers below remain as runtime `import`s. ESM-only keeps `import.meta.url`
// (used by layout.ts to load remote solc) intact.
export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  dts: true,
  clean: true,
  sourcemap: true,
  target: 'node22',
  platform: 'node',
  splitting: false,
  external: [
    '@subsquid/pipes',
    /^@subsquid\/pipes\//,
    'viem',
    'drizzle-orm',
    /^drizzle-orm\//,
    'pg',
    'solc',
  ],
})
