import { afterEach, describe, expect, test } from 'bun:test'
import { loadConfig, resolveConfig } from '../../src/config.ts'

const base = {
  id: 'x',
  address: '0xAAAAaaaAaaAAaAAaAAAaaAaaAAaaAAAAaAaAAAAA',
  deployBlock: 1,
  trackedVariables: [{ variable: 'totalSupply', shape: { slot: 1, valueType: 'uint256' } }],
}

const savedPortal = process.env.PORTAL_URL
afterEach(() => {
  if (savedPortal === undefined) delete process.env.PORTAL_URL
  else process.env.PORTAL_URL = savedPortal
})

describe('resolveConfig', () => {
  test('lowercases the address and defaults the portal URL', () => {
    delete process.env.PORTAL_URL
    const r = resolveConfig(base)
    expect(r.address).toBe('0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')
    expect(r.portalUrl).toBe('https://portal.sqd.dev/datasets/ethereum-mainnet')
  })
  test('honors PORTAL_URL from the environment', () => {
    process.env.PORTAL_URL = 'https://example.test/dataset'
    expect(resolveConfig(base).portalUrl).toBe('https://example.test/dataset')
  })
  test('rejects an invalid address', () => {
    expect(() => resolveConfig({ ...base, address: '0x123' })).toThrow(/Invalid contract address/)
  })
  test('rejects an empty trackedVariables list', () => {
    expect(() => resolveConfig({ ...base, trackedVariables: [] })).toThrow(/nothing to track/)
  })
})

describe('loadConfig', () => {
  test('loads and resolves the project config file', async () => {
    const cfg = await loadConfig()
    expect(cfg.address).toMatch(/^0x[0-9a-f]{40}$/) // resolved to lowercase
    expect(cfg.trackedVariables.length).toBeGreaterThan(0)
    expect(cfg.portalUrl).toContain('http')
  })
})
