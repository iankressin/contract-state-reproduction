/**
 * Decode the events that carry a mapping's keys, so we can compute the storage slots
 * those keys occupy. Generic over any event signature + arg names.
 */
import { type AbiEvent, type Hex, decodeEventLog, parseAbiItem, toEventSelector } from 'viem'

/**
 * Named event args, keyed by the ABI input names. Values are `unknown`: because `makeEventReader`
 * takes the event signature as a RUNTIME string, viem cannot statically derive a per-arg primitive
 * type (its precise `ContractEventArgsFromTopics` typing only kicks in for a narrowable const ABI),
 * so the decoded shape is genuinely `Record<string, unknown>` — viem still validates each value
 * against the ABI at runtime. Callers narrow per arg at the use site.
 */
export type DecodedEventArgs = Record<string, unknown>

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
  decode(log: { topics: Hex[]; data: Hex }): DecodedEventArgs | null
}

export function makeEventReader(eventAbi: string): EventReader {
  const item = parseAbiItem(eventAbi) as AbiEvent
  const topic0 = toEventSelector(item)
  return {
    topic0,
    decode(log) {
      if (log.topics[0] !== topic0) return null // genuine topic0 mismatch — not our event
      const { args } = decodeEventLog({ abi: [item], topics: log.topics as [Hex, ...Hex[]], data: log.data })
      // viem statically types `args` only from a narrowable const ABI; our ABI is parsed from a
      // runtime string, so `args` is left wide (unknown[] | undefined here). At RUNTIME a single
      // named event decodes to a named-arg object, so the precise type is DecodedEventArgs — cast
      // through `unknown` to bridge viem's wide static type to that named shape (no `any`).
      return (args ?? {}) as unknown as DecodedEventArgs
    },
  }
}
