/**
 * GATED end-to-end test (set RUN_E2E=1). Needs: docker-compose Postgres on $DB_URL,
 * a live Portal ($PORTAL_URL), and an archive RPC ($RPC_URL).
 *
 *   docker compose up -d && RUN_E2E=1 pnpm test:e2e
 *
 * It indexes a small recent DAI window through the fluent builder + PostgresSink, then
 * cross-checks the reconstructed values against on-chain state at the last indexed block.
 */
import { Client } from 'pg'
import { http, type Hex, createPublicClient } from 'viem'
import { expect, test } from 'vitest'
import { ContractState } from '../../src/builder.ts'
import { resolvePlans } from '../../src/layout.ts'
import { chainValueAt } from '../../src/oracle.ts'
import { PostgresSink } from '../../src/sink.ts'
import { mapping, scalar } from '../../src/track.ts'

const DAI = '0x6B175474E89094C44Da98b954EedeAC495271d0F'
const address = DAI.toLowerCase() as Hex
const PORTAL = process.env.PORTAL_URL ?? 'https://portal.sqd.dev/datasets/ethereum-mainnet'
const DB_URL = process.env.DB_URL ?? 'postgresql://postgres:postgres@localhost:5432/postgres'

const ABI = [
  { name: 'totalSupply', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { name: 'balanceOf', type: 'function', stateMutability: 'view', inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }] },
] as const

// Reused both to drive the indexer (.track) and to resolve the balanceOf plan for the oracle.
const balanceOf = mapping('balanceOf', { slot: 2, keys: ['address'], value: 'uint256' }).keysFrom(
  'event Transfer(address indexed src, address indexed dst, uint256 wad)',
  [['src'], ['dst']],
)

test.skipIf(!process.env.RUN_E2E)(
  'e2e: index a DAI window and match on-chain state',
  async () => {
    const client = createPublicClient({ transport: http(process.env.RPC_URL) })
    const pg = new Client({ connectionString: DB_URL })
    await pg.connect()

    try {
      await pg.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;') // fresh data + cursor

      const head = Number(await client.getBlockNumber())
      const N = head - 64 // finalized + state available on an archive node

      await ContractState.forContract(DAI)
        .withId('dai-state')
        .onPortal(PORTAL)
        .deployedAt(8_928_674)
        .track(scalar('totalSupply', { slot: 1, type: 'uint256' }))
        .track(balanceOf)
        .track(
          mapping('allowance', { slot: 3, keys: ['address', 'address'], value: 'uint256' }).keysFrom(
            'event Approval(address indexed src, address indexed guy, uint256 wad)',
            [['src', 'guy']],
          ),
        )
        .into(PostgresSink.fromConnectionString(DB_URL))
        .run({ from: N - 1500, to: N })

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
        const chain = (await client.readContract({ address, abi: ABI, functionName: 'totalSupply', blockNumber: BigInt(N) })) as bigint
        expect(BigInt(ts.rows[0].v)).toBe(chain)
      }

      // 3) top balances match the oracle (getStorageAt+decode) AND balanceOf() at block N
      const balancePlan = (await resolvePlans(undefined, [balanceOf._tracked])).find((p) => p.variable === 'balanceOf')!
      const { rows } = await pg.query<{ key1: string; v: string }>(
        `SELECT DISTINCT ON (key1) key1, "valueNum" v FROM state_value
           WHERE variable='balanceOf' AND "blockNumber"<=$1
           ORDER BY key1, "blockNumber" DESC, "transactionIndex" DESC`,
        [N],
      )
      const top = rows.map((r) => ({ h: r.key1 as Hex, db: BigInt(r.v) })).sort((a, b) => (b.db > a.db ? 1 : -1)).slice(0, 3)
      expect(top.length).toBeGreaterThan(0)
      for (const { h, db } of top) {
        const oracle = await chainValueAt(client, address, balancePlan, N, [h])
        const accessor = (await client.readContract({ address, abi: ABI, functionName: 'balanceOf', args: [h], blockNumber: BigInt(N) })) as bigint
        expect(oracle.num).toBe(db)
        expect(accessor).toBe(db)
      }
    } finally {
      await pg.end()
    }
  },
  300_000,
)
