/**
 * Test fixtures: build logs / state diffs / blocks for pipeline tests.
 * Topic hashes are derived with viem (independent of src/events.ts).
 */
import { type Hex, encodeAbiParameters, pad, parseAbiItem, toEventSelector, toHex } from 'viem'
import type { BlockInput, DiffInput, LogInput } from '../src/pipeline.ts'

export const TRANSFER_SIG = 'event Transfer(address indexed from, address indexed to, uint256 value)'
export const APPROVAL_SIG = 'event Approval(address indexed owner, address indexed spender, uint256 value)'
export const TRANSFER_TOPIC = toEventSelector(parseAbiItem(TRANSFER_SIG))
export const APPROVAL_TOPIC = toEventSelector(parseAbiItem(APPROVAL_SIG))

/** A 32-byte word from a number/bigint (right-aligned). */
export const word = (n: bigint | number): Hex => pad(toHex(BigInt(n)), { size: 32 })

/** A log for an event with two indexed addresses + one uint256 in data (Transfer/Approval shape). */
export function indexedAddrEvent(topic0: Hex, a: Hex, b: Hex, value: bigint): LogInput {
  return { topics: [topic0, pad(a, { size: 32 }), pad(b, { size: 32 })], data: encodeAbiParameters([{ type: 'uint256' }], [value]) }
}
export const transferLog = (from: Hex, to: Hex, value: bigint) => indexedAddrEvent(TRANSFER_TOPIC, from, to, value)
export const approvalLog = (owner: Hex, spender: Hex, value: bigint) => indexedAddrEvent(APPROVAL_TOPIC, owner, spender, value)

/**
 * A log whose `topic0` MATCHES Transfer but is otherwise corrupt: it omits the two indexed-address
 * topics, so viem's `decodeEventLog` throws (topics-arity mismatch). Used to exercise the
 * matched-but-undecodable path (strict throw vs resilient warn+drop).
 */
export const malformedTransferLog = (): LogInput => ({ topics: [TRANSFER_TOPIC], data: '0x' })

/** A log whose `topic0` matches NO tracked event — must be skipped without counting as dropped. */
export const unrelatedLog = (): LogInput => ({ topics: [`0x${'ab'.repeat(32)}` as Hex], data: '0x' })

export function diff(key: string, next?: Hex, opts: { prev?: Hex; kind?: string; tx?: number } = {}): DiffInput {
  return { transactionIndex: opts.tx ?? 0, key, kind: opts.kind ?? '*', prev: opts.prev, next }
}

export function block(number: number, parts: { logs?: LogInput[]; stateDiffs?: DiffInput[]; timestamp?: number } = {}): BlockInput {
  return { header: { number, timestamp: parts.timestamp ?? 1_700_000_000 }, logs: parts.logs ?? [], stateDiffs: parts.stateDiffs ?? [] }
}
