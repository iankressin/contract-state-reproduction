/**
 * Postgres schema (Drizzle). Three tables:
 *
 *  - state_log   : append-only RAW storage diffs for the contract (ground truth, generic).
 *  - slot_label  : dictionary mapping a storage slot -> (variable, key1, key2).
 *  - state_value : append-only DECODED value history for tracked variables (scalars and
 *                  single/nested address/uint/... -keyed mappings). value_num holds
 *                  numeric types (uint/int/bool/enum); value_hex holds address/bytesN.
 *
 * Every table has a natural compound PRIMARY KEY — required by the Drizzle target, which
 * installs snapshot triggers keyed on the PK to undo blocks on a reorg. Absent mapping
 * keys use '' (empty string) so the PK columns stay NOT NULL. We only ever INSERT into
 * the *_log/*_value tables (one row per state update).
 */
import { getTableConfig, index, integer, numeric, pgTable, primaryKey, varchar, timestamp } from 'drizzle-orm/pg-core'

export const stateLog = pgTable(
  'state_log',
  {
    contract: varchar({ length: 42 }).notNull(),
    slot: varchar({ length: 66 }).notNull(),
    kind: varchar({ length: 1 }).notNull(), // '+' add | '*' change | '-' delete
    prevValue: varchar({ length: 66 }),
    value: varchar({ length: 66 }),
    blockNumber: integer().notNull(),
    transactionIndex: integer().notNull(),
    blockTimestamp: timestamp(),
  },
  (t) => [primaryKey({ columns: [t.contract, t.slot, t.blockNumber, t.transactionIndex] })],
)

export const slotLabel = pgTable(
  'slot_label',
  {
    contract: varchar({ length: 42 }).notNull(),
    slot: varchar({ length: 66 }).notNull(),
    variable: varchar({ length: 128 }).notNull(),
    key1: varchar({ length: 66 }).notNull().default(''),
    key2: varchar({ length: 66 }).notNull().default(''),
  },
  (t) => [primaryKey({ columns: [t.contract, t.slot] }), index('slot_label_var_idx').on(t.contract, t.variable)],
)

export const stateValue = pgTable(
  'state_value',
  {
    contract: varchar({ length: 42 }).notNull(),
    variable: varchar({ length: 128 }).notNull(),
    key1: varchar({ length: 66 }).notNull().default(''), // mapping key (outer), '' for scalars
    key2: varchar({ length: 66 }).notNull().default(''), // nested mapping key (inner), '' otherwise
    valueNum: numeric({ mode: 'bigint' }), // uint/int/bool/enum
    valueHex: varchar({ length: 66 }), // address/bytesN
    blockNumber: integer().notNull(),
    transactionIndex: integer().notNull(),
    blockTimestamp: timestamp(),
  },
  (t) => [
    // PK prefix (contract, variable, key1, key2, blockNumber) serves "value at block N".
    primaryKey({ columns: [t.contract, t.variable, t.key1, t.key2, t.blockNumber, t.transactionIndex] }),
  ],
)

export const allTables = [stateLog, slotLabel, stateValue]

/**
 * The single source of truth for the table DDL: generated from the Drizzle definitions
 * above (columns, types, NOT NULL, defaults, compound PK, indexes) so the ORM model and
 * the SQL can never drift. Used by the Postgres sink's onStart.
 */
export function createTablesSql(): string {
  const stmts: string[] = []
  for (const table of allTables) {
    const cfg = getTableConfig(table)
    const lines = cfg.columns.map((c) => {
      let line = `  "${c.name}" ${c.getSQLType()}`
      if (c.notNull) line += ' NOT NULL'
      if (c.default !== undefined) line += ` DEFAULT ${typeof c.default === 'string' ? `'${c.default}'` : String(c.default)}`
      return line
    })
    const pk = cfg.primaryKeys[0]
    if (pk) lines.push(`  CONSTRAINT "${cfg.name}_pk" PRIMARY KEY (${pk.columns.map((c) => `"${c.name}"`).join(', ')})`)
    stmts.push(`CREATE TABLE IF NOT EXISTS "${cfg.name}" (\n${lines.join(',\n')}\n);`)
    for (const idx of cfg.indexes) {
      const cols = (idx.config.columns as { name?: string }[]).map((c) => `"${c.name}"`).join(', ')
      stmts.push(`CREATE INDEX IF NOT EXISTS "${idx.config.name}" ON "${cfg.name}" (${cols});`)
    }
  }
  return stmts.join('\n')
}
