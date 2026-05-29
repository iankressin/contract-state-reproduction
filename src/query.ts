/**
 * The single home for "tracked plans -> Portal query": field selection (incl. the
 * prev/next SDK-type workaround), the state-diff request for the contract, and a log
 * request per key-bearing event. Derived from a TrackingContext.
 */
import { evmQuery } from '@subsquid/pipes/evm'
import type { TrackingContext } from './pipeline.ts'

export type BlockRange = { from: number; to?: number }

export function buildStateQuery(tracking: TrackingContext, range: BlockRange) {
  const topic0s = [...tracking.mapByTopic.keys()]
  const query = evmQuery()
    .addFields({
      block: { number: true, timestamp: true },
      log: { address: true, topics: true, data: true, transactionIndex: true, logIndex: true },
      // prev/next are valid portal fields missing from the SDK selection type — cast past it.
      stateDiff: { transactionIndex: true, address: true, key: true, kind: true, prev: true, next: true } as any,
    })
    .addStateDiff({ range, request: { address: [tracking.contract], kind: ['+', '*', '-'] } })
  if (topic0s.length) query.addLog({ range, request: { address: [tracking.contract], topic0: topic0s } })
  return query
}
