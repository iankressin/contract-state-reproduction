/**
 * Decode the events that carry a mapping's keys, so we can compute the storage slots
 * those keys occupy. Generic over any event signature + arg names.
 */
import { type AbiEvent, type Hex, decodeEventLog, parseAbiItem, toEventSelector } from 'viem'

export type EventReader = {
  topic0: Hex
  /**
   * Decode a log's named args. The two failure modes are kept DISTINCT so callers can tell a
   * non-matching log apart from a matching-but-corrupt one:
   *   - returns `null` when the log's `topic0` does not match this reader's event (a genuine
   *     non-match — nothing to decode, skip quietly);
   *   - THROWS when `topic0` DOES match but the body/topics fail to decode (a real data anomaly
   *     the caller must surface, not swallow).
   */
  decode(log: { topics: Hex[]; data: Hex }): Record<string, unknown> | null
}

export function makeEventReader(eventAbi: string): EventReader {
  const item = parseAbiItem(eventAbi) as AbiEvent
  const topic0 = toEventSelector(item)
  return {
    topic0,
    decode(log) {
      if (log.topics[0] !== topic0) return null // genuine topic0 mismatch — not our event
      const { args } = decodeEventLog({ abi: [item], topics: log.topics as [Hex, ...Hex[]], data: log.data })
      return (args ?? {}) as Record<string, unknown>
    },
  }
}
