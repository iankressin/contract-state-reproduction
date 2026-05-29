import { describe, expect, test } from 'bun:test'
import { getTableColumns } from 'drizzle-orm'
import { allTables, createTablesSql, slotLabel, stateLog, stateValue } from '../../src/schema.ts'

describe('schema', () => {
  test('state_log has the raw-diff columns', () => {
    expect(Object.keys(getTableColumns(stateLog)).sort()).toEqual(
      ['blockNumber', 'blockTimestamp', 'contract', 'kind', 'prevValue', 'slot', 'transactionIndex', 'value'].sort(),
    )
  })
  test('state_value has key1/key2 + value_num/value_hex', () => {
    const cols = Object.keys(getTableColumns(stateValue))
    for (const c of ['contract', 'variable', 'key1', 'key2', 'valueNum', 'valueHex', 'blockNumber', 'transactionIndex']) {
      expect(cols).toContain(c)
    }
  })
  test('slot_label maps slot -> variable + keys', () => {
    const cols = Object.keys(getTableColumns(slotLabel))
    for (const c of ['contract', 'slot', 'variable', 'key1', 'key2']) expect(cols).toContain(c)
  })
  test('allTables lists the three tables', () => {
    expect(allTables).toHaveLength(3)
  })

  test('createTablesSql is generated from the defs (single source of truth)', () => {
    const ddl = createTablesSql()
    for (const t of ['state_log', 'slot_label', 'state_value']) {
      expect(ddl).toContain(`CREATE TABLE IF NOT EXISTS "${t}"`)
    }
    expect(ddl).toContain('CONSTRAINT "state_value_pk" PRIMARY KEY')
    expect(ddl).toContain(`"key1" varchar(66) NOT NULL DEFAULT ''`) // default surfaced from the Drizzle def
    expect(ddl).toContain('CREATE INDEX IF NOT EXISTS "slot_label_var_idx"')
  })
})
