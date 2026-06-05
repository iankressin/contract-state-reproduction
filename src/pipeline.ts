/**
 * Pure pipeline logic: turn a batch of decoded blocks into rows for state_log /
 * slot_label / state_value. No DB or network — this is the unit-testable core that
 * main.ts wires into the stream + Drizzle target.
 */
import type { Hex } from 'viem'
import type { TrackedVariable } from './config.ts'
import { type Decoded, decodeWord } from './decode.ts'
import { ConfigError, DecodingError } from './errors.ts'
import { type EventReader, makeEventReader } from './events.ts'
import type { Plan } from './layout.ts'
import type { Logger, Stats } from './observability.ts'
import { slotLabel, stateLog, stateValue } from './schema.ts'
import { encodeKey, keyDisplay, mappingSlot } from './slots.ts'

/** Minimal structural views of the decoded block data we consume. */
export type LogInput = { topics: Hex[]; data: Hex }
export type DiffInput = { transactionIndex: number; key: string; kind: string; prev?: Hex; next?: Hex }
export type BlockInput = { header: { number: number; timestamp: number }; logs: LogInput[]; stateDiffs: DiffInput[] }

type MappingPlan = Extract<Plan, { kind: 'mapping' }>
type MapTracker = { plan: MappingPlan; reader: EventReader; keyTuples: string[][] }

export type TrackingContext = {
  contract: Hex
  scalarSlots: Map<Hex, { variable: string }[]> // fixed slot -> field(s) packed at that slot
  decoders: Map<string, (w: Hex | null | undefined) => Decoded>
  mapByTopic: Map<Hex, MapTracker[]> // event topic0 -> mappings it feeds
}

export type StateRow = typeof stateLog.$inferInsert
export type LabelRow = typeof slotLabel.$inferInsert
export type ValueRow = typeof stateValue.$inferInsert
export type RowBatch = { stateRows: StateRow[]; labelRows: LabelRow[]; valueRows: ValueRow[] }

const ACCOUNT_KEYS = new Set(['balance', 'code', 'nonce'])

/** Build the per-variable decoders, scalar-slot map, and event→mapping index from plans. */
export function buildTrackingContext(contract: Hex, plans: Plan[], trackedVariables: TrackedVariable[]): TrackingContext {
  const decoders = new Map<string, (w: Hex | null | undefined) => Decoded>()
  const scalarSlots = new Map<Hex, { variable: string }[]>()
  for (const p of plans) {
    const offset = p.kind === 'scalar' ? p.offset : 0
    decoders.set(p.variable, (w) => decodeWord(w, p.value, offset, p.decodeBits))
    if (p.kind === 'scalar') {
      const slot = p.slot.toLowerCase() as Hex
      const list = scalarSlots.get(slot) ?? []
      list.push({ variable: p.variable })
      scalarSlots.set(slot, list)
    }
  }

  const mapByTopic = new Map<Hex, MapTracker[]>()
  for (const v of trackedVariables) {
    const plan = plans.find((p) => p.variable === v.variable)
    if (!plan || plan.kind !== 'mapping') continue
    if (!v.keySources?.length) throw new ConfigError(`mapping "${v.variable}" needs keySources (events to discover its keys)`, 'CONFIG_MISSING_KEY_SOURCES')
    for (const ks of v.keySources) {
      const reader = makeEventReader(ks.eventAbi)
      for (const tuple of ks.keyTuples) {
        if (tuple.length !== plan.keyTypes.length) {
          throw new ConfigError(
            `${v.variable}: key tuple ${JSON.stringify(tuple)} has ${tuple.length} args but mapping depth is ${plan.keyTypes.length}`,
            'CONFIG_KEY_TUPLE_ARITY',
          )
        }
      }
      const list = mapByTopic.get(reader.topic0) ?? []
      list.push({ plan, reader, keyTuples: ks.keyTuples })
      mapByTopic.set(reader.topic0, list)
    }
  }

  return { contract, scalarSlots, decoders, mapByTopic }
}

/**
 * Transform a batch of blocks into raw + decoded rows.
 *
 * `options` carries the strict/resilient decode policy plus the logger/stats sink. All fields are
 * optional so existing 2-arg `processBatch(ctx, blocks)` callers keep working (defaulting to today's
 * resilient behavior with no logging/counting).
 */
export function processBatch(ctx: TrackingContext, blocks: BlockInput[], options?: { strict?: boolean; logger?: Logger; stats?: Stats }): RowBatch {
  const { contract, scalarSlots, decoders, mapByTopic } = ctx
  const stateRows: StateRow[] = []
  const labelRows: LabelRow[] = []
  const valueRows: ValueRow[] = []

  // Pass 1: learn mapping slot -> (variable, key1, key2) from this batch's events.
  const labels = new Map<Hex, { variable: string; key1: string; key2: string }>()
  for (const block of blocks) {
    for (const log of block.logs) {
      const trackers = mapByTopic.get((log.topics[0] ?? '0x') as Hex)
      if (!trackers) continue // topic0 doesn't correspond to ANY tracked event — skip quietly
      for (const { plan, reader, keyTuples } of trackers) {
        // The reader was selected by topic0, so this log MATCHED a tracked event. Distinguish a
        // genuine non-match (reader.decode → null, shouldn't happen here) from a matched-but-corrupt
        // log (reader.decode THROWS): the latter is a real data anomaly we must surface, not swallow.
        let args: Record<string, unknown> | null
        try {
          args = reader.decode(log)
        } catch (cause) {
          if (options?.strict) {
            throw new DecodingError(`failed to decode event "${plan.variable}" (topic0 ${reader.topic0}) — corrupt log body or topics`, 'DECODE_EVENT_FAILED', {
              cause,
            })
          }
          options?.logger?.warn(
            { variable: plan.variable, topic0: reader.topic0, block: block.header.number, err: String(cause) },
            'dropped undecodable event log',
          )
          if (options?.stats) options.stats.droppedLogs++
          continue
        }
        if (!args) continue // topic0 mismatch (defensive) — not this reader's event
        for (const tuple of keyTuples) {
          const encoded: Hex[] = []
          const display: string[] = []
          let ok = true
          for (let i = 0; i < tuple.length; i++) {
            const val = args[tuple[i]!]
            if (val === undefined) {
              ok = false
              break
            }
            encoded.push(encodeKey(plan.keyTypes[i]!, val))
            display.push(keyDisplay(plan.keyTypes[i]!, val))
          }
          if (!ok) continue
          const slot = mappingSlot(plan.baseSlot, encoded)
          if (!labels.has(slot)) {
            const key1 = display[0] ?? ''
            const key2 = display[1] ?? ''
            labels.set(slot, { variable: plan.variable, key1, key2 })
            labelRows.push({ contract, slot, variable: plan.variable, key1, key2 })
          }
        }
      }
    }
  }

  // Pass 2: append every storage diff; decode the labeled ones (scalar or mapping).
  for (const block of blocks) {
    const ts = new Date(block.header.timestamp * 1000)
    for (const sd of block.stateDiffs) {
      if (typeof sd.key !== 'string' || ACCOUNT_KEYS.has(sd.key)) continue
      const slot = sd.key.toLowerCase() as Hex
      stateRows.push({
        contract,
        slot,
        kind: sd.kind,
        prevValue: sd.prev ?? null,
        value: sd.next ?? null,
        blockNumber: block.header.number,
        transactionIndex: sd.transactionIndex,
        blockTimestamp: ts,
      })
      // Scalar field(s) at this slot — a packed slot (e.g. a struct) may host several.
      for (const f of scalarSlots.get(slot) ?? []) {
        const decode = decoders.get(f.variable)
        if (!decode) throw new DecodingError(`no decoder for variable "${f.variable}"`, 'DECODE_MISSING_DECODER')
        const dec = decode(sd.next)
        valueRows.push({
          contract,
          variable: f.variable,
          key1: '',
          key2: '',
          valueNum: dec.num,
          valueHex: dec.hex,
          blockNumber: block.header.number,
          transactionIndex: sd.transactionIndex,
          blockTimestamp: ts,
        })
      }
      // Mapping value at this slot (labeled from an event in this batch).
      const label = labels.get(slot)
      if (label) {
        const decode = decoders.get(label.variable)
        if (!decode) throw new DecodingError(`no decoder for variable "${label.variable}"`, 'DECODE_MISSING_DECODER')
        const dec = decode(sd.next)
        valueRows.push({
          contract,
          variable: label.variable,
          key1: label.key1,
          key2: label.key2,
          valueNum: dec.num,
          valueHex: dec.hex,
          blockNumber: block.header.number,
          transactionIndex: sd.transactionIndex,
          blockTimestamp: ts,
        })
      }
    }
  }

  return { stateRows, labelRows, valueRows }
}
