/**
 * Decode the events that carry a mapping's keys, so we can compute the storage slots
 * those keys occupy. Generic over any event signature + arg names.
 */
import { type AbiEvent, type Hex, decodeEventLog, parseAbiItem, toEventSelector } from 'viem'

export type EventReader = {
  topic0: Hex
  /** Decoded named args of a matching log, or null if it doesn't match. */
  decode(log: { topics: Hex[]; data: Hex }): Record<string, unknown> | null
}

export function makeEventReader(eventAbi: string): EventReader {
  const item = parseAbiItem(eventAbi) as AbiEvent
  const topic0 = toEventSelector(item)
  return {
    topic0,
    decode(log) {
      try {
        const { args } = decodeEventLog({ abi: [item], topics: log.topics as [Hex, ...Hex[]], data: log.data })
        return (args ?? {}) as Record<string, unknown>
      } catch {
        return null
      }
    },
  }
}
