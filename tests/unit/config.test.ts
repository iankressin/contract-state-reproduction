import { describe, expect, test } from 'vitest'
import { ContractState } from '../../src/builder.ts'
import { type JobConfig, resolveConfig } from '../../src/config.ts'
import { MemorySink } from '../../src/sink.ts'
import { derived, mapping, scalar } from '../../src/track.ts'

const PORTAL = 'https://portal.sqd.dev/datasets/ethereum-mainnet'
const ADDR = '0x6B175474E89094C44Da98b954EedeAC495271d0F'

const base: JobConfig = {
  id: 'x',
  address: ADDR,
  deployBlock: 1,
  trackedVariables: [{ variable: 'totalSupply', shape: { slot: 1, valueType: 'uint256' } }],
}

describe('resolveConfig', () => {
  test('lowercases the address and attaches the explicit portal URL', () => {
    const r = resolveConfig(base, PORTAL)
    expect(r.address).toBe(ADDR.toLowerCase())
    expect(r.portalUrl).toBe(PORTAL)
  })
  test('rejects an invalid address', () => {
    expect(() => resolveConfig({ ...base, address: '0x123' }, PORTAL)).toThrow(/Invalid contract address/)
  })
  test('rejects an empty trackedVariables list', () => {
    expect(() => resolveConfig({ ...base, trackedVariables: [] }, PORTAL)).toThrow(/nothing to track/)
  })
})

describe('track specs → internal TrackedVariable', () => {
  test('scalar maps type→valueType, with optional offset/bits', () => {
    expect(scalar('totalSupply', { slot: 1, type: 'uint256' })._tracked).toEqual({
      variable: 'totalSupply',
      shape: { slot: 1, valueType: 'uint256' },
    })
    expect(scalar('slot0.tick', { slot: 0, offset: 20, type: 'int24', bits: 255 })._tracked).toEqual({
      variable: 'slot0.tick',
      shape: { slot: 0, offset: 20, valueType: 'int24' },
      decodeBits: 255,
    })
  })
  test('mapping maps keys→keyTypes, value→valueType; keysFrom builds keySources', () => {
    const spec = mapping('allowance', { slot: 3, keys: ['address', 'address'], value: 'uint256' }).keysFrom(
      'event Approval(address indexed src, address indexed guy, uint256 wad)',
      [['src', 'guy']],
    )
    expect(spec._tracked).toEqual({
      variable: 'allowance',
      shape: { slot: 3, keyTypes: ['address', 'address'], valueType: 'uint256' },
      keySources: [
        { eventAbi: 'event Approval(address indexed src, address indexed guy, uint256 wad)', keyTuples: [['src', 'guy']] },
      ],
    })
  })
  test('repeated keysFrom appends multiple key sources', () => {
    const spec = mapping('balanceOf', { slot: 2, keys: ['address'], value: 'uint256' })
      .keysFrom('event Transfer(address indexed src, address indexed dst, uint256 wad)', [['src'], ['dst']])
      .keysFrom('event Mint(address indexed to, uint256 amount)', [['to']])
    expect(spec._tracked.keySources).toHaveLength(2)
  })
  test('derived has no shape (solc-derived at run time)', () => {
    expect(derived('totalSupply')._tracked).toEqual({ variable: 'totalSupply' })
  })
  test('scalar().keysFrom() throws — scalars take no events', () => {
    expect(() => scalar('totalSupply', { slot: 1, type: 'uint256' }).keysFrom('event X()', [['a']])).toThrow(/keysFrom/)
  })
})

describe('ContractState builder validation (fails fast, before any network)', () => {
  const track = () => scalar('totalSupply', { slot: 1, type: 'uint256' })

  test('run() without a portal rejects', async () => {
    await expect(
      ContractState.forContract(ADDR).deployedAt(1).track(track()).into(new MemorySink()).run({ from: 1, to: 2 }),
    ).rejects.toThrow(/no portal/)
  })
  test('run() without a deploy block rejects', async () => {
    await expect(
      ContractState.forContract(ADDR).onPortal(PORTAL).track(track()).into(new MemorySink()).run({ from: 1, to: 2 }),
    ).rejects.toThrow(/no deploy block/)
  })
  test('run() without a sink rejects', async () => {
    await expect(
      ContractState.forContract(ADDR).onPortal(PORTAL).deployedAt(1).track(track()).run({ from: 1, to: 2 }),
    ).rejects.toThrow(/no sink/)
  })
  test('run() with an invalid address rejects', async () => {
    await expect(
      ContractState.forContract('0x123')
        .onPortal(PORTAL)
        .deployedAt(1)
        .track(track())
        .into(new MemorySink())
        .run({ from: 1, to: 2 }),
    ).rejects.toThrow(/Invalid contract address/)
  })
  test('run() with no tracked variables rejects', async () => {
    await expect(
      ContractState.forContract(ADDR).onPortal(PORTAL).deployedAt(1).into(new MemorySink()).run({ from: 1, to: 2 }),
    ).rejects.toThrow(/nothing to track/)
  })
  test('collect() without a bounded `to` rejects', async () => {
    await expect(
      ContractState.forContract(ADDR).onPortal(PORTAL).deployedAt(1).track(track()).collect({ from: 1 }),
    ).rejects.toThrow(/bounded range/)
  })
})
