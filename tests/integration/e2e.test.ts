/**
 * GATED end-to-end test (set RUN_E2E=1). Needs: docker-compose Postgres on $DB_URL,
 * a live Portal ($PORTAL_URL), and an archive RPC ($RPC_URL).
 *
 *   docker compose up -d && RUN_E2E=1 bun test tests/integration/e2e.test.ts
 *
 * It indexes a small recent DAI window through the real pipeline, then cross-checks the
 * reconstructed values against on-chain state at the last indexed block.
 */
import { expect, test } from 'bun:test'
import { Client } from 'pg'
import { http, type Hex, createPublicClient } from 'viem'
import { loadConfig } from '../../src/config.ts'
import { resolvePlans } from '../../src/layout.ts'
import { run } from '../../src/main.ts'
import { chainValueAt } from '../../src/oracle.ts'

const ABI = [
  { name: 'totalSupply', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { name: 'balanceOf', type: 'function', stateMutability: 'view', inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }] },
] as const

test.skipIf(!process.env.RUN_E2E)(
  'e2e: index a DAI window and match on-chain state',
  async () => {
    const cfg = await loadConfig()
    const client = createPublicClient({ transport: http(process.env.RPC_URL) })
    const pg = new Client({ connectionString: process.env.DB_URL })
    await pg.connect()

    try {
      await pg.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;') // fresh data + cursor

      const head = Number(await client.getBlockNumber())
      const N = head - 64 // finalized + state available on an archive node
      await run({ from: N - 1500, to: N })

      // 1) rows were written
      const count = async (t: string) => (await pg.query<{ c: number }>(`SELECT COUNT(*)::int c FROM ${t}`)).rows[0]!.c
      expect(await count('state_log')).toBeGreaterThan(0)
      expect(await count('state_value')).toBeGreaterThan(0)

      // 2) totalSupply (scalar) matches the contract at block N
      const ts = await pg.query<{ v: string }>(
        `SELECT "valueNum" v FROM state_value WHERE variable='totalSupply' AND "blockNumber"<=$1 ORDER BY "blockNumber" DESC, "transactionIndex" DESC LIMIT 1`,
        [N],
      )
      if (ts.rows[0]) {
        const chain = (await client.readContract({ address: cfg.address, abi: ABI, functionName: 'totalSupply', blockNumber: BigInt(N) })) as bigint
        expect(BigInt(ts.rows[0].v)).toBe(chain)
      }

      // 3) top balances match the oracle (getStorageAt+decode) AND balanceOf() at block N
      const balancePlan = (await resolvePlans(cfg.source, cfg.trackedVariables)).find((p) => p.variable === 'balanceOf')!
      const { rows } = await pg.query<{ key1: string; v: string }>(
        `SELECT DISTINCT ON (key1) key1, "valueNum" v FROM state_value
           WHERE variable='balanceOf' AND "blockNumber"<=$1
           ORDER BY key1, "blockNumber" DESC, "transactionIndex" DESC`,
        [N],
      )
      const top = rows.map((r) => ({ h: r.key1 as Hex, db: BigInt(r.v) })).sort((a, b) => (b.db > a.db ? 1 : -1)).slice(0, 3)
      expect(top.length).toBeGreaterThan(0)
      for (const { h, db } of top) {
        const oracle = await chainValueAt(client, cfg.address, balancePlan, N, [h])
        const accessor = (await client.readContract({ address: cfg.address, abi: ABI, functionName: 'balanceOf', args: [h], blockNumber: BigInt(N) })) as bigint
        expect(oracle.num).toBe(db)
        expect(accessor).toBe(db)
      }
    } finally {
      await pg.end()
    }
  },
  300_000,
)
