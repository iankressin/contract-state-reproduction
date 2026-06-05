import { describe, expect, test } from 'vitest'
import { abiTypeOf, compileLayout, resolvePlans } from '../../src/layout.ts'

describe('abiTypeOf', () => {
  test('maps value types to canonical ABI types', () => {
    expect(abiTypeOf({ category: 'address', bytes: 20 })).toBe('address')
    expect(abiTypeOf({ category: 'bool', bytes: 1 })).toBe('bool')
    expect(abiTypeOf({ category: 'uint', bytes: 32 })).toBe('uint256')
    expect(abiTypeOf({ category: 'uint', bytes: 1 })).toBe('uint8')
    expect(abiTypeOf({ category: 'int', bytes: 16 })).toBe('int128')
    expect(abiTypeOf({ category: 'bytes', bytes: 32 })).toBe('bytes32')
  })
})

describe('resolvePlans from inline shapes (no compile)', () => {
  test('scalar', async () => {
    const [p] = await resolvePlans(undefined, [{ variable: 'totalSupply', shape: { slot: 1, valueType: 'uint256' } }])
    expect(p).toMatchObject({ variable: 'totalSupply', kind: 'scalar', value: { category: 'uint', bytes: 32 } })
  })
  test('single + nested mapping', async () => {
    const plans = await resolvePlans(undefined, [
      { variable: 'balanceOf', shape: { slot: 2, keyTypes: ['address'], valueType: 'uint256' } },
      { variable: 'allowance', shape: { slot: 3, keyTypes: ['address', 'address'], valueType: 'uint256' } },
    ])
    expect(plans[0]).toMatchObject({ kind: 'mapping', baseSlot: 2, keyTypes: ['address'] })
    expect(plans[1]).toMatchObject({ kind: 'mapping', baseSlot: 3, keyTypes: ['address', 'address'] })
  })
  test('rejects depth > 2 and unsupported value types', async () => {
    await expect(
      resolvePlans(undefined, [{ variable: 'x', shape: { slot: 0, keyTypes: ['address', 'address', 'address'], valueType: 'uint256' } }]),
    ).rejects.toThrow(/depth/)
    await expect(resolvePlans(undefined, [{ variable: 'x', shape: { slot: 0, valueType: 'string' } }])).rejects.toThrow(/Unsupported value type/)
  })
  test('rejects missing source for a variable without a shape', async () => {
    await expect(resolvePlans(undefined, [{ variable: 'totalSupply' }])).rejects.toThrow(/no shape/)
  })
})

describe('compileLayout + resolvePlans from source (offline, bundled solc)', () => {
  const src = { path: 'contracts/TestToken.sol', contractName: 'TestToken' }

  test('compileLayout exposes raw vars + types', async () => {
    const raw = await compileLayout(src)
    expect(raw.vars._balances).toMatchObject({ slot: 0, offset: 0 })
    expect(raw.vars._totalSupply).toMatchObject({ slot: 2 })
    expect(raw.types[raw.vars._balances!.type]!.encoding).toBe('mapping')
  }, 30_000)

  test('resolvePlans derives scalar / mapping / nested', async () => {
    const plans = await resolvePlans(src, [{ variable: '_totalSupply' }, { variable: '_balances' }, { variable: '_allowances' }])
    const byName = Object.fromEntries(plans.map((p) => [p.variable, p]))
    expect(byName._totalSupply).toMatchObject({ kind: 'scalar', value: { category: 'uint', bytes: 32 } })
    expect(byName._balances).toMatchObject({ kind: 'mapping', baseSlot: 0, keyTypes: ['address'] })
    expect(byName._allowances).toMatchObject({ kind: 'mapping', baseSlot: 1, keyTypes: ['address', 'address'] })
  }, 30_000)

  test('rejects unknown variable and undecodable types', async () => {
    await expect(resolvePlans(src, [{ variable: 'doesNotExist' }])).rejects.toThrow(/not in storage layout/)
    await expect(resolvePlans(src, [{ variable: '_name' }])).rejects.toThrow(/unsupported/i) // string -> raw only
  }, 30_000)

  test('a packed struct expands to one scalar plan per value-type member (correct slot/offset/type)', async () => {
    const plans = await resolvePlans(src, [{ variable: 'packed' }])
    const byName = Object.fromEntries(plans.map((p) => [p.variable, p]))
    // All five members share slot 5 at increasing offsets.
    expect(plans.every((p) => p.kind === 'scalar' && BigInt((p as { slot: `0x${string}` }).slot) === 5n)).toBe(true)
    expect(byName['packed.a']).toMatchObject({ offset: 0, value: { category: 'uint', bytes: 8 } })
    expect(byName['packed.b']).toMatchObject({ offset: 8, value: { category: 'uint', bytes: 8 } })
    expect(byName['packed.c']).toMatchObject({ offset: 16, value: { category: 'uint', bytes: 8 } })
    expect(byName['packed.d']).toMatchObject({ offset: 24, value: { category: 'uint', bytes: 4 } })
    expect(byName['packed.e']).toMatchObject({ offset: 28, value: { category: 'bool', bytes: 1 } })
  }, 30_000)

  test('a dotted path selects a single struct member', async () => {
    const plans = await resolvePlans(src, [{ variable: 'packed.c' }])
    expect(plans).toHaveLength(1)
    expect(plans[0]).toMatchObject({ variable: 'packed.c', kind: 'scalar', offset: 16, value: { category: 'uint', bytes: 8 } })
  }, 30_000)
})

// Exercises the remote-solc path (resolveFullVersion + download + setupMethods). Needs network.
describe('remote solc (RUN_NET)', () => {
  test.skipIf(!process.env.RUN_NET)(
    'downloads a pinned compiler and derives the layout',
    async () => {
      const plans = await resolvePlans({ path: 'contracts/TestToken.sol', contractName: 'TestToken', solcVersion: '0.8.20' }, [{ variable: '_balances' }])
      expect(plans[0]).toMatchObject({ kind: 'mapping', baseSlot: 0, keyTypes: ['address'] })
    },
    120_000,
  )
})
