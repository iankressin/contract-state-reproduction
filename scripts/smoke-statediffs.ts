/**
 * VERIFY-1: Confirm the live Ethereum portal serves storage STATE DIFFS.
 *
 * Streams a small block range for USDC, requests stateDiff fields filtered to the
 * contract address, and prints how many storage-slot diffs arrive (plus a sample).
 *
 *   bun run scripts/smoke-statediffs.ts
 *   FROM=18000000 TO=18000100 bun run scripts/smoke-statediffs.ts
 */
import { evmPortalStream, evmQuery } from '@subsquid/pipes/evm'

const PORTAL_URL = process.env.PORTAL_URL ?? 'https://portal.sqd.dev/datasets/ethereum-mainnet'
const CONTRACT = (process.env.CONTRACT ?? '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48').toLowerCase() // USDC proxy
const FROM = Number(process.env.FROM ?? 18_000_000)
const TO = Number(process.env.TO ?? 18_000_100)

const stream = evmPortalStream({
  id: 'smoke-statediffs',
  portal: { url: PORTAL_URL },
  outputs: evmQuery()
    .addFields({
      block: { number: true, timestamp: true },
      // NOTE: prev/next ARE valid portal fields but are missing from the SDK's selection
      // type (only base fields are typed) — cast past that gap to request the values.
      stateDiff: { transactionIndex: true, address: true, key: true, kind: true, prev: true, next: true } as any,
    })
    .addStateDiff({ range: { from: FROM, to: TO }, request: { address: [CONTRACT as `0x${string}`] } }),
})

let blocks = 0
let allDiffs = 0
let storageDiffs = 0
const kinds: Record<string, number> = {}
const sample: unknown[] = []

for await (const { data } of stream) {
  for (const block of data) {
    blocks++
    for (const sd of (block as any).stateDiffs ?? []) {
      allDiffs++
      kinds[sd.kind] = (kinds[sd.kind] ?? 0) + 1
      const isStorageSlot = sd.key !== 'balance' && sd.key !== 'code' && sd.key !== 'nonce'
      if (isStorageSlot) {
        storageDiffs++
        if (sample.length < 5) sample.push({ block: block.header.number, ...sd })
      }
    }
  }
}

console.log(
  JSON.stringify(
    { contract: CONTRACT, from: FROM, to: TO, blocksScanned: blocks, allDiffs, storageDiffs, kinds, sample },
    null,
    2,
  ),
)
console.log(storageDiffs > 0 ? '\n✅ STATE DIFFS ARE SERVED' : '\n❌ NO STORAGE DIFFS RETURNED')