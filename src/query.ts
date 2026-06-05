/**
 * The single home for "tracked plans -> Portal query": field selection (incl. the
 * prev/next SDK-type workaround), the state-diff request for the contract, and a log
 * request per key-bearing event. Derived from a TrackingContext.
 */
import { evmQuery } from '@subsquid/pipes/evm'
import type { TrackingContext } from './pipeline.ts'

export type BlockRange = { from: number; to?: number }

/**
 * The state-diff fields we select. `prev`/`next` are real Portal storage-diff fields (they
 * appear on the decoded +/-/* diff variants) but the SDK's `StateDiffFieldSelection` only
 * exposes the four base keys below — and that type isn't re-exported from a public entrypoint
 * to augment. We keep `prev`/`next` on the runtime selection (the Portal needs them to return
 * the values) and cast the object to this exact 4-key shape so the two extra keys are erased
 * from the static type the SDK's `Subset<>` constraint checks — replacing the former broad
 * `as any` with a precise, `any`-free boundary.
 */
type SelectedStateDiffFields = {
  transactionIndex: boolean
  address: boolean
  key: boolean
  kind: boolean
}

export function buildStateQuery(tracking: TrackingContext, range: BlockRange) {
  const topic0s = [...tracking.mapByTopic.keys()]
  const query = evmQuery()
    .addFields({
      block: { number: true, timestamp: true },
      log: { address: true, topics: true, data: true, transactionIndex: true, logIndex: true },
      stateDiff: { transactionIndex: true, address: true, key: true, kind: true, prev: true, next: true } as SelectedStateDiffFields,
    })
    .addStateDiff({ range, request: { address: [tracking.contract], kind: ['+', '*', '-'] } })
  if (topic0s.length) query.addLog({ range, request: { address: [tracking.contract], topic0: topic0s } })
  return query
}
