import { describe, expect, test } from 'vitest'
import type { TrackedVariable } from '../../src/config.ts'
import type { BlockRange } from '../../src/query.ts'
import {
  type Problem,
  validateAddress,
  validateBuilderInput,
  validateDeployBlock,
  validatePortalUrl,
  validateRange,
  validateTrackedVariables,
} from '../../src/validation.ts'

const ADDR = '0x6B175474E89094C44Da98b954EedeAC495271d0F'
const PORTAL = 'https://portal.sqd.dev/datasets/ethereum-mainnet'

/** Extract the set of codes from a problem list (order-independent assertions). */
const codes = (problems: Problem[]): string[] => problems.map((p) => p.code)

describe('validateAddress', () => {
  test('valid 20-byte hex passes with no problems', () => {
    expect(validateAddress(ADDR)).toEqual([])
    expect(validateAddress('0x' + 'a'.repeat(40))).toEqual([])
  })

  const bad: Array<[string, string | undefined, string]> = [
    ['undefined → missing', undefined, 'CONFIG_NO_ADDRESS'],
    ['empty string → missing', '', 'CONFIG_NO_ADDRESS'],
    ['too short → invalid', '0x123', 'CONFIG_INVALID_ADDRESS'],
    ['too long → invalid', '0x' + 'a'.repeat(41), 'CONFIG_INVALID_ADDRESS'],
    ['no 0x prefix → invalid', 'a'.repeat(40), 'CONFIG_INVALID_ADDRESS'],
    ['non-hex chars → invalid', '0x' + 'z'.repeat(40), 'CONFIG_INVALID_ADDRESS'],
  ]
  for (const [label, input, code] of bad) {
    test(label, () => {
      const problems = validateAddress(input)
      expect(problems).toHaveLength(1)
      expect(problems[0]!.code).toBe(code)
      expect(problems[0]!.path).toBe('address')
      expect(problems[0]!.message).toBeTruthy()
    })
  }
})

describe('validatePortalUrl', () => {
  test('valid http(s) URLs pass', () => {
    expect(validatePortalUrl(PORTAL)).toEqual([])
    expect(validatePortalUrl('http://localhost:3000/dataset')).toEqual([])
  })

  test('missing → CONFIG_NO_PORTAL', () => {
    expect(codes(validatePortalUrl(undefined))).toEqual(['CONFIG_NO_PORTAL'])
    expect(codes(validatePortalUrl(''))).toEqual(['CONFIG_NO_PORTAL'])
  })

  const badUrls: Array<[string, string]> = [
    ['not-a-url', 'not a url at all'],
    ['ftp protocol', 'ftp://example.com/x'],
    ['ws protocol', 'ws://example.com/x'],
    ['file protocol', 'file:///etc/hosts'],
    ['bare host (no scheme)', 'portal.sqd.dev/datasets/x'],
  ]
  for (const [label, url] of badUrls) {
    test(`invalid: ${label} → CONFIG_INVALID_PORTAL_URL`, () => {
      const problems = validatePortalUrl(url)
      expect(problems).toHaveLength(1)
      expect(problems[0]!.code).toBe('CONFIG_INVALID_PORTAL_URL')
      expect(problems[0]!.path).toBe('portalUrl')
    })
  }
})

describe('validateDeployBlock', () => {
  test('valid non-negative integers pass (incl. 0)', () => {
    expect(validateDeployBlock(0)).toEqual([])
    expect(validateDeployBlock(8_928_674)).toEqual([])
  })

  test('missing → CONFIG_NO_DEPLOY_BLOCK', () => {
    expect(codes(validateDeployBlock(undefined))).toEqual(['CONFIG_NO_DEPLOY_BLOCK'])
  })

  const badBlocks: Array<[string, number]> = [
    ['negative', -1],
    ['fractional', 1.5],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['NaN', Number.NaN],
  ]
  for (const [label, block] of badBlocks) {
    test(`invalid: ${label} → CONFIG_INVALID_DEPLOY_BLOCK`, () => {
      const problems = validateDeployBlock(block)
      expect(problems).toHaveLength(1)
      expect(problems[0]!.code).toBe('CONFIG_INVALID_DEPLOY_BLOCK')
      expect(problems[0]!.path).toBe('deployBlock')
    })
  }
})

describe('validateRange', () => {
  test('undefined range is always valid (backfill-then-follow)', () => {
    expect(validateRange(undefined)).toEqual([])
    expect(validateRange(undefined, 100)).toEqual([])
  })

  test('open-ended range { from } with no deployBlock passes', () => {
    expect(validateRange({ from: 10 })).toEqual([])
  })

  test('from === to is allowed (single-block window)', () => {
    expect(validateRange({ from: 5, to: 5 })).toEqual([])
  })

  test('from < to is allowed', () => {
    expect(validateRange({ from: 5, to: 9 })).toEqual([])
  })

  test('from > to → CONFIG_INVALID_RANGE', () => {
    const problems = validateRange({ from: 9, to: 5 })
    expect(codes(problems)).toEqual(['CONFIG_INVALID_RANGE'])
    expect(problems[0]!.message).toMatch(/from=9 is after to=5/)
  })

  test('from < deployBlock → CONFIG_INVALID_RANGE', () => {
    const problems = validateRange({ from: 50 }, 100)
    expect(codes(problems)).toEqual(['CONFIG_INVALID_RANGE'])
    expect(problems[0]!.message).toMatch(/before deployBlock=100/)
  })

  test('from >= deployBlock passes', () => {
    expect(validateRange({ from: 100 }, 100)).toEqual([])
    expect(validateRange({ from: 150, to: 200 }, 100)).toEqual([])
  })

  const badFrom: Array<[string, BlockRange]> = [
    ['negative from', { from: -1 }],
    ['fractional from', { from: 1.5 }],
  ]
  for (const [label, range] of badFrom) {
    test(`${label} → CONFIG_INVALID_RANGE on range.from`, () => {
      const problems = validateRange(range)
      expect(codes(problems)).toEqual(['CONFIG_INVALID_RANGE'])
      expect(problems[0]!.path).toBe('range.from')
    })
  }

  test('negative to → CONFIG_INVALID_RANGE on range.to', () => {
    const problems = validateRange({ from: 0, to: -3 })
    expect(codes(problems)).toEqual(['CONFIG_INVALID_RANGE'])
    expect(problems[0]!.path).toBe('range.to')
  })

  test('accumulates multiple range violations (bad from AND from<deployBlock skipped, but from>to reported)', () => {
    // from is a valid integer but after `to` AND before deployBlock → two distinct problems.
    const problems = validateRange({ from: 90, to: 80 }, 100)
    expect(problems.length).toBe(2)
    expect(codes(problems).every((c) => c === 'CONFIG_INVALID_RANGE')).toBe(true)
    expect(problems.some((p) => /is after to=80/.test(p.message))).toBe(true)
    expect(problems.some((p) => /before deployBlock=100/.test(p.message))).toBe(true)
  })
})

describe('validateTrackedVariables', () => {
  const scalar = (variable: string): TrackedVariable => ({ variable, shape: { slot: 1, valueType: 'uint256' } })
  const mappingVar = (variable: string, keyTuples: string[][]): TrackedVariable => ({
    variable,
    shape: { slot: 2, keyTypes: ['address'], valueType: 'uint256' },
    keySources: [{ eventAbi: `event ${variable}(address indexed a)`, keyTuples }],
  })

  test('a single scalar passes', () => {
    expect(validateTrackedVariables([scalar('totalSupply')])).toEqual([])
  })

  test('a well-formed mapping with keySources passes', () => {
    expect(validateTrackedVariables([mappingVar('balanceOf', [['a']])])).toEqual([])
  })

  test('empty list → CONFIG_NO_TRACKED_VARS', () => {
    expect(codes(validateTrackedVariables([]))).toEqual(['CONFIG_NO_TRACKED_VARS'])
  })

  test('undefined list → CONFIG_NO_TRACKED_VARS', () => {
    expect(codes(validateTrackedVariables(undefined))).toEqual(['CONFIG_NO_TRACKED_VARS'])
  })

  test('duplicate variable name → CONFIG_DUPLICATE_VARIABLE naming the dup', () => {
    const problems = validateTrackedVariables([scalar('balanceOf'), scalar('balanceOf')])
    expect(codes(problems)).toEqual(['CONFIG_DUPLICATE_VARIABLE'])
    expect(problems[0]!.message).toMatch(/"balanceOf"/)
    expect(problems[0]!.path).toBe('trackedVariables[1].variable')
  })

  test('mapping (keyTypes present) without keySources → CONFIG_MISSING_KEY_SOURCES', () => {
    const v: TrackedVariable = { variable: 'balanceOf', shape: { slot: 2, keyTypes: ['address'], valueType: 'uint256' } }
    const problems = validateTrackedVariables([v])
    expect(codes(problems)).toEqual(['CONFIG_MISSING_KEY_SOURCES'])
    expect(problems[0]!.message).toMatch(/"balanceOf"/)
  })

  test('scalar (no keyTypes, no keySources) is NOT forced to have keySources', () => {
    expect(validateTrackedVariables([scalar('totalSupply')])).toEqual([])
  })

  test('derived (no shape, no keySources) is NOT forced to be a mapping here', () => {
    // Whether a `derived` var resolves to a mapping needs the resolved layout — not checked statically.
    expect(validateTrackedVariables([{ variable: 'totalSupply' }])).toEqual([])
  })

  test('keySources present with a shape that has no keyTypes still counts as a mapping (passes)', () => {
    // `derived`-style: no inline keyTypes, but keys bound via keySources ⇒ treated as a mapping,
    // and since keySources are present the missing-keySources rule does not fire.
    const v: TrackedVariable = {
      variable: 'allowance',
      keySources: [{ eventAbi: 'event Approval(address indexed o, address indexed s)', keyTuples: [['o', 's']] }],
    }
    expect(validateTrackedVariables([v])).toEqual([])
  })

  test('inconsistent key-tuple arity within one variable → CONFIG_KEY_TUPLE_ARITY', () => {
    // Two key paths of different lengths can't both match a single mapping depth.
    const problems = validateTrackedVariables([mappingVar('balanceOf', [['a'], ['a', 'b']])])
    expect(codes(problems)).toEqual(['CONFIG_KEY_TUPLE_ARITY'])
    expect(problems[0]!.message).toMatch(/inconsistent lengths/)
  })

  test('consistent key-tuple arity (multiple single-key paths) passes', () => {
    // balanceOf fed by Transfer(from,to) → [['from'],['to']]: both arity 1, fine.
    expect(validateTrackedVariables([mappingVar('balanceOf', [['from'], ['to']])])).toEqual([])
  })

  test('accumulates problems across multiple variables', () => {
    const problems = validateTrackedVariables([
      scalar('totalSupply'),
      scalar('totalSupply'), // duplicate
      { variable: 'balanceOf', shape: { slot: 2, keyTypes: ['address'], valueType: 'uint256' } }, // missing keySources
    ])
    expect(codes(problems)).toEqual(expect.arrayContaining(['CONFIG_DUPLICATE_VARIABLE', 'CONFIG_MISSING_KEY_SOURCES']))
    expect(problems).toHaveLength(2)
  })
})

describe('validateBuilderInput (aggregator)', () => {
  const validInput = {
    address: ADDR,
    portalUrl: PORTAL,
    deployBlock: 1,
    range: { from: 1, to: 2 } as BlockRange,
    trackedVariables: [{ variable: 'totalSupply', shape: { slot: 1, valueType: 'uint256' } }] as TrackedVariable[],
  }

  test('fully valid input → no problems', () => {
    expect(validateBuilderInput(validInput)).toEqual([])
  })

  test('valid without a range (backfill-then-follow) → no problems', () => {
    const { range, ...noRange } = validInput
    expect(validateBuilderInput(noRange)).toEqual([])
  })

  test('empty input accumulates one problem per missing field (address, portal, deployBlock, trackedVars)', () => {
    const problems = validateBuilderInput({})
    expect(codes(problems)).toEqual(['CONFIG_NO_ADDRESS', 'CONFIG_NO_PORTAL', 'CONFIG_NO_DEPLOY_BLOCK', 'CONFIG_NO_TRACKED_VARS'])
  })

  test('problems are ordered by field: address → portal → deployBlock → range → trackedVariables', () => {
    const problems = validateBuilderInput({
      address: '0xbad',
      portalUrl: 'nope',
      deployBlock: -1,
      range: { from: 5, to: 1 },
      trackedVariables: [],
    })
    expect(codes(problems)).toEqual([
      'CONFIG_INVALID_ADDRESS',
      'CONFIG_INVALID_PORTAL_URL',
      'CONFIG_INVALID_DEPLOY_BLOCK',
      'CONFIG_INVALID_RANGE',
      'CONFIG_NO_TRACKED_VARS',
    ])
  })

  test('the FIRST problem is what the throw-path would surface (code + message)', () => {
    const [first] = validateBuilderInput({ ...validInput, address: '0x123' })
    expect(first).toBeDefined()
    expect(first!.code).toBe('CONFIG_INVALID_ADDRESS')
    expect(first!.message).toMatch(/Invalid contract address/)
  })

  test('range validated against deployBlock through the aggregator', () => {
    const problems = validateBuilderInput({ ...validInput, deployBlock: 100, range: { from: 50, to: 200 } })
    expect(codes(problems)).toEqual(['CONFIG_INVALID_RANGE'])
    expect(problems[0]!.message).toMatch(/before deployBlock=100/)
  })
})
