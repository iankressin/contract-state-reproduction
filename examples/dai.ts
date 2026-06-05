/**
 * Example: reproduce DAI's historical state into Postgres with the fluent builder.
 *
 *   pnpm example                                       # backfill deploy -> head, then follow live
 *   FROM_BLOCK=8928674 TO_BLOCK=8932674 pnpm example   # a bounded window
 *
 * DAI was compiled with solc 0.5.12 (predates storageLayout), so each variable's shape is pinned
 * inline via scalar()/mapping() — no .sol source and no solc needed. In your own project, import
 * from '@iankressin/contract-state' instead of '../src/index.ts'.
 */
import { ContractState, mapping, PostgresSink, scalar } from '../src/index.ts'

const PORTAL_URL = process.env.PORTAL_URL ?? 'https://portal.sqd.dev/datasets/ethereum-mainnet'
const DB_URL = process.env.DB_URL ?? 'postgresql://postgres:postgres@localhost:5432/postgres'
const DEPLOY_BLOCK = 8_928_674

const from = process.env.FROM_BLOCK ? Number(process.env.FROM_BLOCK) : undefined
const to = process.env.TO_BLOCK ? Number(process.env.TO_BLOCK) : undefined
// A bounded window when either bound is given (from defaults to the deploy block); else live-follow.
const range = from != null || to != null ? { from: from ?? DEPLOY_BLOCK, ...(to != null ? { to } : {}) } : undefined

await ContractState.forContract('0x6B175474E89094C44Da98b954EedeAC495271d0F')
  .withId('dai-state')
  .onPortal(PORTAL_URL)
  .deployedAt(DEPLOY_BLOCK)
  .track(scalar('totalSupply', { slot: 1, type: 'uint256' }))
  .track(
    mapping('balanceOf', { slot: 2, keys: ['address'], value: 'uint256' }).keysFrom('event Transfer(address indexed src, address indexed dst, uint256 wad)', [
      ['src'],
      ['dst'],
    ]),
  )
  .track(
    mapping('allowance', { slot: 3, keys: ['address', 'address'], value: 'uint256' }).keysFrom(
      'event Approval(address indexed src, address indexed guy, uint256 wad)',
      [['src', 'guy']],
    ),
  )
  .into(PostgresSink.fromConnectionString(DB_URL))
  .run(range)
