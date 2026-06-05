/**
 * The deep indexing module: resolve plans → build tracking context → build the Portal query
 * → hand the stream to a sink. The source (Portal) and the sink (Postgres / in-memory) are
 * the seams; everything in between lives here once.
 */
import { evmPortalStream } from '@subsquid/pipes/evm'
import type { ResolvedConfig } from './config.ts'
import { resolvePlans } from './layout.ts'
import { defaultLogger, newStats } from './observability.ts'
import type { RunOptions } from './options.ts'
import { buildTrackingContext } from './pipeline.ts'
import { type BlockRange, buildStateQuery } from './query.ts'
import type { BlockStream, StateSink } from './sink.ts'

export async function indexState(config: ResolvedConfig, sink: StateSink, range?: BlockRange, opts?: RunOptions): Promise<void> {
  const r: BlockRange = range ?? { from: config.deployBlock, ...(config.toBlock != null ? { to: config.toBlock } : {}) }

  // Build the run context bag ONCE here and thread it down: the options as given, the resolved logger,
  // and a fresh stats counter for this run.
  const run = opts ?? {}
  const logger = run.logger ?? defaultLogger
  const stats = newStats()

  const plans = await resolvePlans(config.source, config.trackedVariables)
  const tracking = buildTrackingContext(config.address, plans, config.trackedVariables)

  logger.info(`Tracking ${config.address} from block ${r.from}:`)
  for (const p of plans) {
    const v = `${p.value.category}${p.value.bytes * 8}`
    logger.info(
      p.kind === 'scalar'
        ? `  - ${p.variable}: scalar ${v} @ slot ${BigInt(p.slot)}`
        : `  - ${p.variable}: mapping[${p.keyTypes.join('][')}] => ${v} @ baseSlot ${p.baseSlot}`,
    )
  }

  const stream = evmPortalStream({ id: config.id, portal: { url: config.portalUrl }, outputs: buildStateQuery(tracking, r) })
  await sink.consume(stream as unknown as BlockStream, tracking, { run, logger, stats })
}
