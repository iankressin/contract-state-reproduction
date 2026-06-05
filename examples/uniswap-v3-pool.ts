/**
 * Example: reproduce ALL of a Uniswap V3 pool's directly-decodable storage variables over a block
 * range, with the packed `Slot0` struct expanded into its individual fields.
 *
 *   pnpm example:uniswap                                   # default window, prints a reconstruction
 *   FROM_BLOCK=17000000 TO_BLOCK=17000100 pnpm example:uniswap
 *   RPC_URL=https://eth.llamarpc.com pnpm example:uniswap  # also cross-checks against the chain
 *
 * UniswapV3Pool storage layout (from Uniswap/v3-core v1.0.0). We track every value-typed slot via
 * inline scalar() shapes — no .sol source / solc needed:
 *
 *   slot 0  Slot0 (packed, 31/32 bytes) -> 7 fields, each at its byte offset:
 *             sqrtPriceX96 uint160 @0 · tick int24 @20 · observationIndex uint16 @23 ·
 *             observationCardinality uint16 @25 · observationCardinalityNext uint16 @27 ·
 *             feeProtocol uint8 @29 · unlocked bool @30
 *   slot 1  feeGrowthGlobal0X128 uint256
 *   slot 2  feeGrowthGlobal1X128 uint256
 *   slot 3  protocolFees (packed) -> token0 uint128 @0 · token1 uint128 @16
 *   slot 4  liquidity uint128
 *   slot 5  ticks       mapping(int24  => Tick.Info)        ┐ NOT value-decoded (struct values /
 *   slot 6  tickBitmap  mapping(int16  => uint256)          │ keys not emitted verbatim by any
 *   slot 7  positions   mapping(bytes32=> Position.Info)    │ event / fixed array). They still land
 *   slot 8  observations Oracle.Observation[65535]          ┘ in the raw state_log — see "Coverage".
 *
 * factory/token0/token1/fee/tickSpacing/maxLiquidityPerTick are immutables (in bytecode, not
 * storage) and aren't tracked. In your own project, import from '@iankressin/contract-state'.
 */
import { http, type Hex, createPublicClient } from 'viem'
import { ContractState, scalar } from '../src/index.ts'
import { resolvePlans } from '../src/layout.ts'
import { chainValueAt } from '../src/oracle.ts'

const POOL = '0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640' as Hex // USDC/WETH 0.05% (token0=USDC, token1=WETH)
const PORTAL_URL = process.env.PORTAL_URL ?? 'https://portal.sqd.dev/datasets/ethereum-mainnet'
const DEPLOY_BLOCK = 12_376_729 // pool creation; only the cursor lower-bound default (we pass `from`)

const FROM = process.env.FROM_BLOCK ? Number(process.env.FROM_BLOCK) : 17_000_000
const TO = process.env.TO_BLOCK ? Number(process.env.TO_BLOCK) : FROM + 100

// Every value-typed storage variable. Offsets are bytes from the slot's least-significant end.
const tracks = [
  // slot 0 — Slot0 packed struct
  scalar('slot0.sqrtPriceX96', { slot: 0, offset: 0, type: 'uint160' }),
  scalar('slot0.tick', { slot: 0, offset: 20, type: 'int24' }),
  scalar('slot0.observationIndex', { slot: 0, offset: 23, type: 'uint16' }),
  scalar('slot0.observationCardinality', { slot: 0, offset: 25, type: 'uint16' }),
  scalar('slot0.observationCardinalityNext', { slot: 0, offset: 27, type: 'uint16' }),
  scalar('slot0.feeProtocol', { slot: 0, offset: 29, type: 'uint8' }),
  scalar('slot0.unlocked', { slot: 0, offset: 30, type: 'bool' }),
  // slots 1–2 — global fee growth
  scalar('feeGrowthGlobal0X128', { slot: 1, type: 'uint256' }),
  scalar('feeGrowthGlobal1X128', { slot: 2, type: 'uint256' }),
  // slot 3 — protocolFees packed struct
  scalar('protocolFees.token0', { slot: 3, offset: 0, type: 'uint128' }),
  scalar('protocolFees.token1', { slot: 3, offset: 16, type: 'uint128' }),
  // slot 4 — in-range liquidity
  scalar('liquidity', { slot: 4, type: 'uint128' }),
]
const names = tracks.map((t) => t._tracked.variable)

const ethPriceUsdc = (sqrtPriceX96: bigint) => 1e12 / (Number(sqrtPriceX96) / 2 ** 96) ** 2

// ── Index the bounded window into memory ──
const { valueRows, stateRows } = await ContractState.forContract(POOL)
  .withId('uniswap-v3-pool-state')
  .onPortal(PORTAL_URL)
  .deployedAt(DEPLOY_BLOCK)
  .track(...tracks)
  .collect({ from: FROM, to: TO })

// ── Reconstruct each field's value as of a block (latest write at or before it) ──
type Series = { blocks: number[]; byBlock: Map<number, bigint> }
const series = new Map<string, Series>()
const tsByBlock = new Map<number, Date>()
for (const name of names) {
  const tip = new Map<number, { tx: number; v: bigint }>()
  for (const r of valueRows) {
    if (r.variable !== name || r.valueNum == null) continue
    if (r.blockTimestamp) tsByBlock.set(r.blockNumber, r.blockTimestamp)
    const cur = tip.get(r.blockNumber)
    if (!cur || r.transactionIndex >= cur.tx) tip.set(r.blockNumber, { tx: r.transactionIndex, v: r.valueNum })
  }
  const blocks = [...tip.keys()].sort((a, b) => a - b)
  series.set(name, { blocks, byBlock: new Map(blocks.map((b) => [b, tip.get(b)!.v])) })
}
const valueAt = (name: string, bn: number): bigint | undefined => {
  const s = series.get(name)
  let res: bigint | undefined
  if (s) for (const b of s.blocks) b <= bn ? (res = s.byBlock.get(b)) : null
  return res
}
const fmt = (name: string, v: bigint | undefined) => (v == null ? '—' : name === 'slot0.unlocked' ? (v === 1n ? 'true' : 'false') : v.toString())

// Sample first / middle / last block where the price moved (sqrtPriceX96 writes on every swap).
const priceBlocks = series.get('slot0.sqrtPriceX96')!.blocks
const samples = [...new Set([priceBlocks[0], priceBlocks[priceBlocks.length >> 1], priceBlocks[priceBlocks.length - 1]])].filter((b): b is number => b != null)

console.log(`\nUniswap V3 pool ${POOL} — reconstructed storage over blocks ${FROM}–${TO}`)
if (!samples.length) {
  console.log('No slot0 updates in this window — try a wider FROM_BLOCK/TO_BLOCK range.')
} else {
  console.log(`Decoded ${valueRows.length} value writes; sampling ${samples.length} block(s):\n`)
  for (const bn of samples) {
    const ts = tsByBlock.get(bn)
    console.log(`■ block ${bn}${ts ? `  (${ts.toISOString()})` : ''}`)
    for (const name of names) {
      const v = valueAt(name, bn)
      const note = name === 'slot0.sqrtPriceX96' && v != null ? `   (~$${ethPriceUsdc(v).toFixed(2)}/ETH)` : ''
      console.log(`    ${name.padEnd(32)} = ${fmt(name, v)}${note}`)
    }
    console.log('')
  }
}

// ── Coverage: decoded value fields vs the raw slot writes the stream also captured ──
const plans = await resolvePlans(
  undefined,
  tracks.map((t) => t._tracked),
)
const decodedSlots = new Set(plans.map((p) => BigInt((p as { slot: Hex }).slot))) // slots 0–4
const counts = new Map<string, number>()
for (const r of valueRows) counts.set(r.variable, (counts.get(r.variable) ?? 0) + 1)
const rawOther = stateRows.filter((r) => !decodedSlots.has(BigInt(r.slot)))
const distinctOther = new Set(rawOther.map((r) => r.slot.toLowerCase())).size

console.log('Coverage')
console.log(`  decoded: ${valueRows.length} writes across ${names.length} named value fields (slots 0–4)`)
for (const name of names) console.log(`    ${name.padEnd(32)} ${counts.get(name) ?? 0}`)
console.log(`  raw-only: ${rawOther.length} writes across ${distinctOther} distinct slots NOT value-decoded`)
console.log('    → ticks(5) / tickBitmap(6) / positions(7) / observations(8): mapping & array storage,')
console.log('      captured in state_log but not expanded (struct values / non-verbatim keys / fixed array).')

// ── Optional: cross-check a few sampled fields against the chain (only when RPC_URL is set) ──
if (process.env.RPC_URL && samples.length) {
  const client = createPublicClient({ transport: http(process.env.RPC_URL) })
  const POOL_ABI = [
    {
      name: 'slot0',
      type: 'function',
      stateMutability: 'view',
      inputs: [],
      outputs: [
        { name: 'sqrtPriceX96', type: 'uint160' },
        { name: 'tick', type: 'int24' },
        { name: 'observationIndex', type: 'uint16' },
        { name: 'observationCardinality', type: 'uint16' },
        { name: 'observationCardinalityNext', type: 'uint16' },
        { name: 'feeProtocol', type: 'uint8' },
        { name: 'unlocked', type: 'bool' },
      ],
    },
    { name: 'liquidity', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint128' }] },
  ] as const
  const planOf = (v: string) => plans.find((p) => p.variable === v)!
  const eq = (label: string, a: bigint, b: bigint) => {
    if (a !== b) throw new Error(`mismatch @ ${label}: ${a} !== ${b}`)
  }

  for (const bn of samples) {
    const s0 = (await client.readContract({ address: POOL, abi: POOL_ABI, functionName: 'slot0', blockNumber: BigInt(bn) })) as readonly [
      bigint,
      number,
      ...unknown[],
    ]
    const liq = (await client.readContract({ address: POOL, abi: POOL_ABI, functionName: 'liquidity', blockNumber: BigInt(bn) })) as bigint

    // oracle (getStorageAt + same decode path) must agree with the public getters …
    eq(`slot0.sqrtPriceX96/getter @${bn}`, (await chainValueAt(client, POOL, planOf('slot0.sqrtPriceX96'), bn)).num!, s0[0])
    eq(`slot0.tick/getter @${bn}`, (await chainValueAt(client, POOL, planOf('slot0.tick'), bn)).num!, BigInt(s0[1]))
    eq(`liquidity/getter @${bn}`, (await chainValueAt(client, POOL, planOf('liquidity'), bn)).num!, liq)
    // … and our reconstructed (Portal-streamed) values must match the chain where we have them.
    const rSqrt = valueAt('slot0.sqrtPriceX96', bn)
    const rTick = valueAt('slot0.tick', bn)
    const rLiq = valueAt('liquidity', bn)
    if (rSqrt != null) eq(`slot0.sqrtPriceX96/indexer @${bn}`, rSqrt, s0[0])
    if (rTick != null) eq(`slot0.tick/indexer @${bn}`, rTick, BigInt(s0[1]))
    if (rLiq != null) eq(`liquidity/indexer @${bn}`, rLiq, liq)
  }
  console.log(`\n✅ ${samples.length}/${samples.length} sampled block(s): slot plans match the oracle + on-chain getters`)
}

// To persist + live-follow instead of collecting in memory, swap the terminal call for a sink:
//   import { PostgresSink } from '../src/index.ts'
//   await ContractState.forContract(POOL)
//     .withId('uniswap-v3-pool-state').onPortal(PORTAL_URL).deployedAt(DEPLOY_BLOCK)
//     .track(...tracks)
//     .into(PostgresSink.fromConnectionString(process.env.DB_URL ?? 'postgresql://postgres:postgres@localhost:5432/postgres'))
//     .run() // omit the range to backfill deploy -> head, then follow live
