/**
 * VERIFY-3: cross-check reconstructed values against on-chain state, for all tracked
 * shapes — scalar (totalSupply), mapping (balanceOf), nested mapping (allowance).
 *
 * For each sampled row, compares the latest state_value at block N against BOTH
 * eth_getStorageAt(derived slot) and the contract's own accessor at block N. Because
 * state-diff `next` values are absolute and we index contiguously to N, the latest row
 * <= N must equal the on-chain value at N.
 *
 *   bun run scripts/verify-values.ts
 */
import { Client } from 'pg'
import { http, type Hex, createPublicClient } from 'viem'
import { loadConfig } from '../src/config.ts'
import { type Plan, resolvePlans } from '../src/layout.ts'
import { chainValueAt } from '../src/oracle.ts'

const ABI = [
  { name: 'totalSupply', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { name: 'balanceOf', type: 'function', stateMutability: 'view', inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }] },
  { name: 'allowance', type: 'function', stateMutability: 'view', inputs: [{ type: 'address' }, { type: 'address' }], outputs: [{ type: 'uint256' }] },
] as const

const cfg = await loadConfig()
const plans = await resolvePlans(cfg.source, cfg.trackedVariables)
const planOf = (v: string) => plans.find((p) => p.variable === v)
const pg = new Client({ connectionString: process.env.DB_URL })
await pg.connect()
const client = createPublicClient({ transport: http(process.env.RPC_URL) })

const { rows: m } = await pg.query<{ n: number }>(`SELECT MAX("blockNumber")::int AS n FROM state_value WHERE contract=$1`, [cfg.address])
const N = m[0]?.n
if (!N) throw new Error('state_value is empty — run the indexer first (bun run src/main.ts)')
console.log(`Indexed up to block ${N}. Cross-checking at block ${N}:\n`)

let pass = 0
let total = 0
const check = async (label: string, plan: Plan, keys: string[], db: bigint, call: Promise<bigint>) => {
  total++
  const [oracle, accessor] = await Promise.all([chainValueAt(client, cfg.address, plan, N, keys), call])
  const ok = db === oracle.num && db === accessor
  if (ok) pass++
  console.log(`${ok ? '✅' : '❌'} ${label}  db=${db} storage=${oracle.num} accessor=${accessor}`)
}

// --- totalSupply (scalar) ---
const tsPlan = planOf('totalSupply')
if (tsPlan) {
  const { rows } = await pg.query<{ v: string }>(
    `SELECT "valueNum" v FROM state_value WHERE contract=$1 AND variable='totalSupply' AND "blockNumber"<=$2 ORDER BY "blockNumber" DESC,"transactionIndex" DESC LIMIT 1`,
    [cfg.address, N],
  )
  if (rows[0]) {
    console.log('— totalSupply (scalar) —')
    await check('totalSupply', tsPlan, [], BigInt(rows[0].v), client.readContract({ address: cfg.address, abi: ABI, functionName: 'totalSupply', blockNumber: BigInt(N) }) as Promise<bigint>)
  }
}

// --- balanceOf (mapping[address]) ---
const balPlan = planOf('balanceOf')
if (balPlan) {
  const { rows } = await pg.query<{ key1: string; v: string }>(
    `SELECT DISTINCT ON (key1) key1, "valueNum" v FROM state_value
       WHERE contract=$1 AND variable='balanceOf' AND "blockNumber"<=$2
       ORDER BY key1, "blockNumber" DESC,"transactionIndex" DESC`,
    [cfg.address, N],
  )
  const top = rows.map((r) => ({ holder: r.key1 as Hex, db: BigInt(r.v) })).sort((a, b) => (b.db > a.db ? 1 : -1)).slice(0, 8)
  console.log(`\n— balanceOf (mapping[address]), top ${top.length} of ${rows.length} holders —`)
  for (const { holder, db } of top) {
    await check(`balanceOf[${holder}]`, balPlan, [holder], db, client.readContract({ address: cfg.address, abi: ABI, functionName: 'balanceOf', args: [holder], blockNumber: BigInt(N) }) as Promise<bigint>)
  }
}

// --- allowance (mapping[address][address]) ---
const allowPlan = planOf('allowance')
if (allowPlan) {
  const { rows } = await pg.query<{ key1: string; key2: string; v: string }>(
    `SELECT DISTINCT ON (key1, key2) key1, key2, "valueNum" v FROM state_value
       WHERE contract=$1 AND variable='allowance' AND "blockNumber"<=$2
       ORDER BY key1, key2, "blockNumber" DESC,"transactionIndex" DESC`,
    [cfg.address, N],
  )
  const top = rows.map((r) => ({ o: r.key1 as Hex, s: r.key2 as Hex, db: BigInt(r.v) })).sort((a, b) => (b.db > a.db ? 1 : -1)).slice(0, 8)
  console.log(`\n— allowance (mapping[address][address]), top ${top.length} of ${rows.length} pairs —`)
  for (const { o, s, db } of top) {
    await check(`allowance[${o}][${s}]`, allowPlan, [o, s], db, client.readContract({ address: cfg.address, abi: ABI, functionName: 'allowance', args: [o, s], blockNumber: BigInt(N) }) as Promise<bigint>)
  }
}

await pg.end()
console.log(`\n${pass}/${total} checks matched on-chain state at block ${N}`)
if (pass !== total) process.exit(1)
console.log('✅ VERIFY-3 PASSED')
