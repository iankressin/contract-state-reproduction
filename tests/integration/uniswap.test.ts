/**
 * Track state of a Uniswap V3 pool via the real indexing path (indexState + MemorySink) —
 * no hand-rolled stream. We track TWO fields packed into storage slot 0 of the pool's Slot0
 * struct: sqrtPriceX96 (uint160 @ offset 0) and tick (int24 @ offset 20). This exercises the
 * multi-field-per-slot model (#4) and offset+signed decoding, then cross-checks each field
 * against the chain through the shared oracle (#5) + the pool's slot0() accessor.
 *
 * Pool: USDC/WETH 0.05% (token0 = USDC, token1 = WETH).
 *   RUN_E2E=1 bun test tests/integration/uniswap.test.ts
 */
import { describe, expect, test } from 'bun:test'
import { http, type Hex, createPublicClient } from 'viem'
import { type TrackedVariable, resolveConfig } from '../../src/config.ts'
import { indexState } from '../../src/indexer.ts'
import { resolvePlans } from '../../src/layout.ts'
import { chainValueAt } from '../../src/oracle.ts'
import { MemorySink } from '../../src/sink.ts'

const POOL = '0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640' as Hex // Uniswap V3 USDC/WETH 0.05%

// Two fields packed into slot 0 of the Slot0 struct (both via inline shapes — no source needed).
const TRACKED: TrackedVariable[] = [
  { variable: 'slot0.sqrtPriceX96', shape: { slot: 0, offset: 0, valueType: 'uint160' } },
  { variable: 'slot0.tick', shape: { slot: 0, offset: 20, valueType: 'int24' } },
]

const SLOT0_ABI = [
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
] as const

const ethPriceUsdc = (sqrtPriceX96: bigint) => 1e12 / (Number(sqrtPriceX96) / 2 ** 96) ** 2

describe('Uniswap V3 pool — track two packed fields of slot0', () => {
  test('both fields resolve to scalar plans sharing slot 0 at different offsets', async () => {
    const plans = await resolvePlans(undefined, TRACKED)
    const byName = Object.fromEntries(plans.map((p) => [p.variable, p]))
    expect(byName['slot0.sqrtPriceX96']).toMatchObject({ kind: 'scalar', offset: 0, value: { category: 'uint', bytes: 20 } })
    expect(byName['slot0.tick']).toMatchObject({ kind: 'scalar', offset: 20, value: { category: 'int', bytes: 3 } })
    expect(plans.every((p) => p.kind === 'scalar' && BigInt((p as { slot: Hex }).slot) === 0n)).toBe(true)
  })

  test.skipIf(!process.env.RUN_E2E)(
    'reconstructs sqrtPriceX96 + tick history and matches the chain',
    async () => {
      const client = createPublicClient({ transport: http(process.env.RPC_URL) })
      const to = Number(await client.getBlockNumber()) - 64
      const from = to - 50

      const cfg = resolveConfig({ id: 'uniswap-slot0', address: POOL, deployBlock: 0, trackedVariables: TRACKED })
      const sink = new MemorySink()
      await indexState(cfg, sink, { from, to })

      const value = sink.rows.valueRows
      expect(value.length).toBeGreaterThan(0)
      expect(value.some((r) => r.variable === 'slot0.sqrtPriceX96')).toBe(true)
      expect(value.some((r) => r.variable === 'slot0.tick')).toBe(true)

      // Collapse per-tx rows to the last value per block (what the chain exposes at block N).
      const lastPerBlock = (variable: string) => {
        const m = new Map<number, { tx: number; v: bigint }>()
        for (const r of value.filter((x) => x.variable === variable)) {
          const cur = m.get(r.blockNumber)
          if (!cur || r.transactionIndex >= cur.tx) m.set(r.blockNumber, { tx: r.transactionIndex, v: r.valueNum! })
        }
        return m
      }
      const sqrt = lastPerBlock('slot0.sqrtPriceX96')
      const tick = lastPerBlock('slot0.tick')
      const blocks = [...sqrt.keys()].sort((a, b) => a - b)
      const showIdx = [...new Set([0, blocks.length >> 1, blocks.length - 1])]

      console.log(`\nReconstructed ${sqrt.size} slot0 updates over blocks ${from}–${to} (pool ${POOL}):`)
      for (const i of showIdx) {
        const bn = blocks[i]!
        console.log(`  block ${bn}  sqrtPriceX96=${sqrt.get(bn)!.v}  tick=${tick.get(bn)!.v}  (~$${ethPriceUsdc(sqrt.get(bn)!.v).toFixed(2)}/ETH)`)
      }

      // Cross-check each sampled block-end value via the oracle (getStorageAt+decode) AND slot0().
      const plans = await resolvePlans(undefined, TRACKED)
      const planOf = (v: string) => plans.find((p) => p.variable === v)!
      for (const i of showIdx) {
        const bn = blocks[i]!
        const s0 = (await client.readContract({ address: POOL, abi: SLOT0_ABI, functionName: 'slot0', blockNumber: BigInt(bn) })) as readonly [bigint, number, ...unknown[]]
        expect(sqrt.get(bn)!.v).toBe((await chainValueAt(client, POOL, planOf('slot0.sqrtPriceX96'), bn)).num!)
        expect(sqrt.get(bn)!.v).toBe(s0[0])
        expect(tick.get(bn)!.v).toBe((await chainValueAt(client, POOL, planOf('slot0.tick'), bn)).num!)
        expect(tick.get(bn)!.v).toBe(BigInt(s0[1]))
      }
      console.log(`\n✅ ${showIdx.length}/${showIdx.length} sampled blocks: sqrtPriceX96 + tick match oracle + slot0() on-chain`)
    },
    180_000,
  )
})
