/**
 * CLI entry: reproduce a contract's historical state into Postgres.
 *
 *   bun run src/main.ts
 *
 * Thin wrapper around indexState + the Postgres sink. The reusable pieces live in
 * indexer.ts (orchestration), query.ts (Portal query), sink.ts (persistence seam), and
 * pipeline.ts (the pure transform).
 */
import { drizzle } from 'drizzle-orm/node-postgres'
import { loadConfig } from './config.ts'
import { indexState } from './indexer.ts'
import { PostgresSink } from './sink.ts'

export async function run(opts: { from?: number; to?: number } = {}): Promise<void> {
  const cfg = await loadConfig()
  const from = opts.from ?? (process.env.FROM_BLOCK ? Number(process.env.FROM_BLOCK) : undefined)
  const to = opts.to ?? (process.env.TO_BLOCK ? Number(process.env.TO_BLOCK) : undefined)
  if (from != null) cfg.deployBlock = from
  if (to != null) cfg.toBlock = to

  const db = drizzle(process.env.DB_URL ?? 'postgresql://postgres:postgres@localhost:5432/postgres')
  await indexState(cfg, new PostgresSink(db))
}

// Only start the indexer when run directly (not when imported by tests).
if (import.meta.main) {
  run().catch((e) => {
    console.error(e)
    process.exit(1)
  })
}
