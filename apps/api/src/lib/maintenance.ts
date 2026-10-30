import { sql } from 'drizzle-orm'
import { db } from '../db'
import { enrichPending } from './assetEnrich'
import { requeueStaleJobs } from './jobs'

const MAINTENANCE_INTERVAL_MS = 10 * 60 * 1000

// Rate-limit rows idle for an hour are past any window we use.
async function pruneRateLimits(): Promise<number> {
  const rows = await db.execute(
    sql`DELETE FROM rate_limit WHERE window_start < now() - interval '1 hour' RETURNING key`,
  )
  return rows.length
}

// A group's key is its sorted member ids joined with '|'. Once any member
// is deleted from the board that exact group can never re-form, so its
// panel state is dead weight. Groups whose members all still exist are
// kept — they can re-form when items are dragged back together.
async function pruneOrphanGroupState(): Promise<number> {
  const rows = await db.execute(sql`
    DELETE FROM board_group_display g
    WHERE EXISTS (
      SELECT 1 FROM unnest(string_to_array(g.group_key, '|')) AS member(id)
      WHERE NOT EXISTS (
        SELECT 1 FROM board_object o WHERE o.board_id = g.board_id AND o.id = member.id
      )
    )
    RETURNING g.id
  `)
  return rows.length
}

export async function runMaintenance(): Promise<void> {
  const [rateLimits, groups] = await Promise.all([pruneRateLimits(), pruneOrphanGroupState()])
  if (rateLimits + groups > 0) {
    console.log(`[maintenance] pruned ${rateLimits} rate-limit rows, ${groups} orphan group states`)
  }
  // Library metadata for assets recorded before the library existed, or
  // whose in-request enrichment didn't finish.
  // Render jobs whose worker died mid-run go back on the queue.
  const stale = await requeueStaleJobs()
  if (stale.requeued + stale.failed > 0) {
    console.log(`[maintenance] stale jobs: ${stale.requeued} requeued, ${stale.failed} failed`)
  }
  const enriched = await enrichPending()
  if (enriched > 0) console.log(`[maintenance] enriched ${enriched} library assets`)
}

export function startMaintenance(): void {
  const tick = () => runMaintenance().catch((e) => console.warn('[maintenance] failed', e))
  void tick()
  setInterval(tick, MAINTENANCE_INTERVAL_MS).unref()
}
