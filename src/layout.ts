/**
 * Storage layout + decode-plan resolution.
 *
 * Compiles Solidity source via solc-js to get the storage layout, then resolves each
 * tracked variable into a decode PLAN — scalar (fixed slot + value type) or mapping
 * (base slot + ordered key types + value type), supporting nested mappings. Plans can
 * also be built from inline `shape` overrides when source isn't compiled.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, resolve as resolvePath } from 'node:path'
import type { Hex } from 'viem'
import type { ShapeOverride, SourceConfig, TrackedVariable, ValueCategory } from './config.ts'
import { scalarSlot } from './slots.ts'

export type ValueType = { category: ValueCategory; bytes: number }

export type Plan = { variable: string; decodeBits?: number } & (
  | { kind: 'scalar'; slot: Hex; offset: number; value: ValueType }
  | { kind: 'mapping'; baseSlot: number; keyTypes: string[]; value: ValueType }
)

type StructMember = { label: string; slot: string; offset: number; type: string }
type RawType = { encoding?: string; numberOfBytes?: string; label?: string; key?: string; value?: string; members?: StructMember[] }
type RawLayout = { vars: Record<string, { slot: number; offset: number; type: string }>; types: Record<string, RawType> }

// ---------- type parsing ----------

/** Map a solc type id (e.g. "t_uint256") to a value-type descriptor, or null if not a value type. */
function parseSolcType(typeId: string, types: Record<string, RawType>): ValueType | null {
  let m: RegExpMatchArray | null
  if ((m = typeId.match(/^t_uint(\d+)$/))) return { category: 'uint', bytes: Number(m[1]) / 8 }
  if ((m = typeId.match(/^t_int(\d+)$/))) return { category: 'int', bytes: Number(m[1]) / 8 }
  if (typeId.startsWith('t_address') || typeId.startsWith('t_contract')) return { category: 'address', bytes: 20 }
  if (typeId === 't_bool') return { category: 'bool', bytes: 1 }
  if ((m = typeId.match(/^t_bytes(\d+)$/))) return { category: 'bytes', bytes: Number(m[1]) } // fixed bytesN
  if (typeId.startsWith('t_enum')) return { category: 'uint', bytes: Number(types[typeId]?.numberOfBytes ?? 1) }
  return null // mapping / array / struct / string / dynamic bytes / userDefined
}

/** Parse a Solidity type string (e.g. "uint256", "address", "bytes32") into a value-type descriptor. */
function parseSolidityType(t: string): ValueType {
  let m: RegExpMatchArray | null
  if ((m = t.match(/^uint(\d*)$/))) return { category: 'uint', bytes: (Number(m[1]) || 256) / 8 }
  if ((m = t.match(/^int(\d*)$/))) return { category: 'int', bytes: (Number(m[1]) || 256) / 8 }
  if (t === 'address') return { category: 'address', bytes: 20 }
  if (t === 'bool') return { category: 'bool', bytes: 1 }
  if ((m = t.match(/^bytes(\d+)$/))) return { category: 'bytes', bytes: Number(m[1]) }
  throw new Error(`Unsupported value type "${t}" (supported: uintN, intN, address, bool, bytesN)`)
}

/** Canonical ABI type string for a value type — used to ABI-encode mapping keys. */
export function abiTypeOf(v: ValueType): string {
  switch (v.category) {
    case 'address':
      return 'address'
    case 'bool':
      return 'bool'
    case 'uint':
      return `uint${v.bytes * 8}`
    case 'int':
      return `int${v.bytes * 8}`
    case 'bytes':
      return `bytes${v.bytes}`
  }
}

// ---------- solc compilation ----------

type SolcLike = { compile: (input: string, opts?: { import?: (p: string) => unknown }) => string }
type SolcModule = SolcLike & { version?: () => string; setupMethods: (m: unknown) => SolcLike }

/**
 * Lazy-load the optional `solc` peer. Only the source-derivation path needs it, so inline-shape
 * users (the common case) never pull it. Throws a crisp, actionable error when it's missing.
 */
async function loadSolc(): Promise<SolcModule> {
  try {
    return (await import('solc')).default as SolcModule
  } catch {
    throw new Error(
      "Compiling from source requires the optional 'solc' peer dependency. " +
        'Install it (e.g. `pnpm add solc`) or pin variable shapes inline via `shape` / `scalar()` / `mapping()`.',
    )
  }
}

async function resolveFullVersion(version: string): Promise<string> {
  const v = version.replace(/^v/, '')
  const list = (await fetch('https://binaries.soliditylang.org/bin/list.json').then((r) => r.json())) as {
    releases?: Record<string, string>
  }
  const file = list.releases?.[v]
  if (!file) throw new Error(`solc ${v} not found in the release list`)
  return file.replace(/^soljson-/, '').replace(/\.js$/, '')
}

async function getCompiler(version?: string): Promise<SolcLike> {
  const solc = await loadSolc()
  const bundledVersion: string = typeof solc.version === 'function' ? solc.version() : ''
  if (!version || bundledVersion.startsWith(version.replace(/^v/, ''))) return solc
  // Fetch + cache the soljson bundle ourselves and wrap it with setupMethods (the low-level API);
  // this portable path avoids solc.loadRemoteVersion's reliance on Node's Module._compile.
  const full = await resolveFullVersion(version)
  const cacheDir = resolvePath(process.cwd(), '.solc-cache')
  const file = resolvePath(cacheDir, `soljson-${full}.js`)
  if (!existsSync(file)) {
    mkdirSync(cacheDir, { recursive: true })
    writeFileSync(file, await fetch(`https://binaries.soliditylang.org/bin/soljson-${full}.js`).then((r) => r.text()))
  }
  return solc.setupMethods(createRequire(import.meta.url)(file))
}

export async function compileLayout(src: SourceConfig): Promise<RawLayout> {
  const sourcePath = resolvePath(process.cwd(), src.path)
  const content = readFileSync(sourcePath, 'utf8')
  const fileKey = src.path.split('/').pop() ?? 'Contract.sol'
  const baseDir = dirname(sourcePath)

  const findImports = (p: string): { contents: string } | { error: string } => {
    for (const cand of [resolvePath(baseDir, p), resolvePath(process.cwd(), p), resolvePath(process.cwd(), 'node_modules', p)]) {
      try {
        return { contents: readFileSync(cand, 'utf8') }
      } catch {}
    }
    return { error: `Import not found: ${p}` }
  }

  const input = {
    language: 'Solidity',
    sources: { [fileKey]: { content } },
    settings: {
      ...(src.optimizer ? { optimizer: src.optimizer } : {}),
      ...(src.evmVersion ? { evmVersion: src.evmVersion } : {}),
      outputSelection: { '*': { '*': ['storageLayout'] } },
    },
  }

  const compiler = await getCompiler(src.solcVersion)
  const output = JSON.parse(compiler.compile(JSON.stringify(input), { import: findImports }))
  const fatal = (output.errors ?? []).filter((e: { severity: string }) => e.severity === 'error')
  if (fatal.length) throw new Error('solc compilation failed:\n' + fatal.map((e: { formattedMessage: string }) => e.formattedMessage).join('\n'))

  let layout: { storage?: unknown[]; types?: Record<string, RawType> } | undefined
  for (const file of Object.values(output.contracts ?? {})) {
    const c = (file as Record<string, { storageLayout?: typeof layout }>)[src.contractName]
    if (c?.storageLayout) {
      layout = c.storageLayout
      break
    }
  }
  if (!layout) {
    throw new Error(
      `Contract "${src.contractName}" with a storageLayout not found. ` + `(solc < 0.5.13 cannot emit storageLayout — pin shapes via \`shape\` instead.)`,
    )
  }

  const vars: RawLayout['vars'] = {}
  for (const s of (layout.storage ?? []) as Array<{ label: string; slot: string; offset: number; type: string }>) {
    vars[s.label] = { slot: Number(s.slot), offset: Number(s.offset), type: s.type }
  }
  return { vars, types: layout.types ?? {} }
}

// ---------- plan resolution ----------

function planFromShape(variable: string, shape: ShapeOverride, decodeBits?: number): Plan {
  const value = parseSolidityType(shape.valueType)
  if (shape.keyTypes && shape.keyTypes.length > 0) {
    // validate key types parse
    for (const k of shape.keyTypes) parseSolidityType(k)
    if (shape.keyTypes.length > 2) throw new Error(`${variable}: decoded layer supports mapping depth <= 2`)
    return { variable, kind: 'mapping', baseSlot: shape.slot, keyTypes: shape.keyTypes, value, decodeBits }
  }
  return { variable, kind: 'scalar', slot: scalarSlot(shape.slot), offset: shape.offset ?? 0, value, decodeBits }
}

/** A value-type struct member -> scalar plan at its (absolute slot, offset). */
function memberPlan(name: string, baseSlot: number, m: StructMember, types: Record<string, RawType>, decodeBits?: number): Plan | null {
  const value = parseSolcType(m.type, types)
  if (!value) return null // nested struct / mapping / array member — not decoded
  return { variable: name, kind: 'scalar', slot: scalarSlot(baseSlot + Number(m.slot)), offset: m.offset, value, decodeBits }
}

/** Resolve a tracked variable to one or more plans (a struct expands to its value-type members). */
function plansFromLayout(variable: string, raw: RawLayout, decodeBits?: number): Plan[] {
  // Dotted path "struct.member" selects a single struct member.
  if (variable.includes('.')) {
    const dot = variable.indexOf('.')
    const parent = variable.slice(0, dot)
    const memberName = variable.slice(dot + 1)
    const entry = raw.vars[parent]
    if (!entry) throw new Error(`Variable "${parent}" not in storage layout. Known: ${Object.keys(raw.vars).join(', ') || '(none)'}`)
    const member = raw.types[entry.type]?.members?.find((m) => m.label === memberName)
    if (!member) throw new Error(`Struct "${parent}" has no member "${memberName}"`)
    const plan = memberPlan(variable, entry.slot, member, raw.types, decodeBits)
    if (!plan) throw new Error(`${variable}: unsupported member type ${member.type}`)
    return [plan]
  }

  const entry = raw.vars[variable]
  if (!entry) {
    throw new Error(`Variable "${variable}" not in storage layout. Known: ${Object.keys(raw.vars).join(', ') || '(none)'}`)
  }
  const t = raw.types[entry.type]

  if (t?.encoding === 'mapping') {
    const keyTypes: string[] = []
    let cur = entry.type
    while (raw.types[cur]?.encoding === 'mapping') {
      const keyId = raw.types[cur]!.key!
      const kt = parseSolcType(keyId, raw.types)
      if (!kt) throw new Error(`${variable}: unsupported mapping key type ${keyId}`)
      keyTypes.push(abiTypeOf(kt))
      cur = raw.types[cur]!.value!
    }
    if (keyTypes.length > 2) throw new Error(`${variable}: decoded layer supports mapping depth <= 2`)
    const value = parseSolcType(cur, raw.types)
    if (!value) throw new Error(`${variable}: unsupported mapping value type ${cur} (only value types are decoded)`)
    return [{ variable, kind: 'mapping', baseSlot: entry.slot, keyTypes, value, decodeBits }]
  }

  // Struct: expand to one scalar plan per value-type member, named "<var>.<member>".
  if (t?.members) {
    const plans = t.members.map((m) => memberPlan(`${variable}.${m.label}`, entry.slot, m, raw.types, decodeBits)).filter((p): p is Plan => p !== null)
    if (!plans.length) throw new Error(`${variable}: struct has no value-type members to decode`)
    return plans
  }

  const value = parseSolcType(entry.type, raw.types)
  if (!value) {
    throw new Error(`${variable}: unsupported type ${entry.type} (arrays/strings/dynamic bytes are captured raw in state_log only)`)
  }
  return [{ variable, kind: 'scalar', slot: scalarSlot(entry.slot), offset: entry.offset, value, decodeBits }]
}

/** Resolve every tracked variable into a decode plan (compiling source only if needed). */
export async function resolvePlans(src: SourceConfig | undefined, vars: TrackedVariable[]): Promise<Plan[]> {
  const needCompile = vars.some((v) => !v.shape)
  const raw = needCompile ? (src ? await compileLayout(src) : undefined) : undefined
  if (needCompile && !raw) {
    const missing = vars.filter((v) => !v.shape).map((v) => v.variable)
    throw new Error(`No source to compile, and these variables have no shape: ${missing.join(', ')}`)
  }
  return vars.flatMap((v) => (v.shape ? [planFromShape(v.variable, v.shape, v.decodeBits)] : plansFromLayout(v.variable, raw!, v.decodeBits)))
}
