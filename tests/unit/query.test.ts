import { describe, expect, test } from 'vitest'
import type { TrackedVariable } from '../../src/config.ts'
import { resolvePlans } from '../../src/layout.ts'
import { buildTrackingContext } from '../../src/pipeline.ts'
import { buildStateQuery } from '../../src/query.ts'
import { TRANSFER_SIG, TRANSFER_TOPIC } from '../fixtures.ts'

const CONTRACT = '0x6b175474e89094c44da98b954eedeac495271d0f'
const requestsOf = (q: unknown) => (q as { getRequests(): { request: Record<string, { address?: string[]; topic0?: string[] }[]> }[] }).getRequests()

async function query(tracked: TrackedVariable[]) {
  const plans = await resolvePlans(undefined, tracked)
  const ctx = buildTrackingContext(CONTRACT as `0x${string}`, plans, tracked)
  return requestsOf(buildStateQuery(ctx, { from: 0, to: 10 }))
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
})
