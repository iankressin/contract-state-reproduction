import { describe, expect, test } from 'vitest'
import type { TrackedVariable } from '../../src/config.ts'
import { resolvePlans } from '../../src/layout.ts'
import { buildTrackingContext } from '../../src/pipeline.ts'
import { buildStateQuery } from '../../src/query.ts'
import { TRANSFER_SIG, TRANSFER_TOPIC } from '../fixtures.ts'

const CONTRACT = '0x6b175474e89094c44da98b954eedeac495271d0f'
const requestsOf = (q: unknown) => (q as { getRequests(): { request: Record<string, { address?: string[]; topic0?: string[] }[]> }[] }).getRequests()
// Field selection lives in `addFields` and is NOT serialized into `getRequests()` (which only
// carries per-request filter criteria); the SDK query object exposes it via `getFields()`.
const fieldsOf = (q: unknown) => (q as { getFields(): { stateDiff?: Record<string, boolean> } }).getFields()

async function buildQuery(tracked: TrackedVariable[]) {
  const plans = await resolvePlans(undefined, tracked)
  const ctx = buildTrackingContext(CONTRACT as `0x${string}`, plans, tracked)
  return buildStateQuery(ctx, { from: 0, to: 10 })
}

async function query(tracked: TrackedVariable[]) {
  return requestsOf(await buildQuery(tracked))
}

describe('buildStateQuery', () => {
  test('a scalar-only tracking requests state diffs for the address, no logs', async () => {
    const reqs = await query([{ variable: 'totalSupply', shape: { slot: 1, valueType: 'uint256' } }])
    const sd = reqs.find((r) => r.request.stateDiffs)
    expect(sd?.request.stateDiffs?.[0]?.address).toEqual([CONTRACT])
    expect(reqs.some((r) => r.request.logs)).toBe(false)
  })

  test('a tracked mapping also requests its event logs', async () => {
    const reqs = await query([
      {
        variable: 'balanceOf',
        shape: { slot: 2, keyTypes: ['address'], valueType: 'uint256' },
        keySources: [{ eventAbi: TRANSFER_SIG, keyTuples: [['from'], ['to']] }],
      },
    ])
    expect(reqs.some((r) => r.request.stateDiffs)).toBe(true)
    const logs = reqs.find((r) => r.request.logs)
    expect(logs?.request.logs?.[0]?.address).toEqual([CONTRACT])
    expect(logs?.request.logs?.[0]?.topic0).toEqual([TRANSFER_TOPIC])
  })

  // `prev`/`next` are load-bearing: the Portal won't return previous/next storage values without
  // them, and they sit behind a typed cast in query.ts that erases them from the static field type.
  // Lock the runtime selection so an accidental drop can't silently regress the data.
  test('the state-diff field selection includes prev/next (plus the four base fields)', async () => {
    const fields = fieldsOf(await buildQuery([{ variable: 'totalSupply', shape: { slot: 1, valueType: 'uint256' } }]))
    expect(fields.stateDiff).toEqual({
      transactionIndex: true,
      address: true,
      key: true,
      kind: true,
      prev: true,
      next: true,
    })
  })
})
