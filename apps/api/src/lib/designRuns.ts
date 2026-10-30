import {
  designVariantSchema,
  proposedSlotSchema,
  type DesignRun,
  type DesignVariant,
  type OutputFormat,
} from '@moodboard/shared'
import { and, desc, eq, ne, sql } from 'drizzle-orm'
import { alias } from 'drizzle-orm/pg-core'
import { nanoid } from 'nanoid'
import { z } from 'zod'
import { db, schema } from '../db'
import type { DesignCache } from './designer'
import { linearForUser } from './linearConnection'
import { defaultModelClient } from './orchestrator'
import { linearPostGate, postOutputComment } from './linearPost'
import { outputThumbnail } from './outputRender'
import { getOutputSummary, shareOutput } from './outputs'
import {
  existingMarkers,
  modelSlotProposer,
  SLOT_PROPOSER_TAG,
  type ProposalCache,
  type SlotProposer,
} from './slotProposer'
import { parseFormat } from './templates'

// Design runs (one design_output call: its brief, inputs and variants), the
// person's pick, the Linear post-back, and the output agents' Postgres cache
// (design_cache: designer variants and slot proposals).

const creator = alias(schema.user, 'design_run_creator')

function runsQuery() {
  return db
    .select({
      run: schema.designRun,
      clientName: schema.client.name,
      kitName: schema.styleKit.name,
      createdByName: creator.name,
    })
    .from(schema.designRun)
    .leftJoin(schema.client, eq(schema.client.id, schema.designRun.clientId))
    .leftJoin(schema.styleKit, eq(schema.styleKit.id, schema.designRun.kitId))
    .leftJoin(creator, eq(creator.id, schema.designRun.createdBy))
}

type RunRow = Awaited<ReturnType<ReturnType<typeof runsQuery>['limit']>>[number]

const variantsSchema = z.array(designVariantSchema)

function toDesignRun(row: RunRow): DesignRun {
  const r = row.run
  const variants = variantsSchema.safeParse(r.variants)
  return {
    id: r.id,
    boardId: r.boardId,
    format: parseFormat(r.format),
    brief: r.brief,
    clientId: r.clientId,
    clientName: row.clientName,
    kitId: r.kitId,
    kitName: row.kitName,
    kitVersion: r.kitVersion,
    variants: variants.success ? variants.data : [],
    chosenOutputId: r.chosenOutputId,
    linearIssue: r.linearIssue,
    linearCommentUrl: r.linearCommentUrl,
    postedAt: r.postedAt?.toISOString() ?? null,
    createdByName: row.createdByName,
    createdAt: r.createdAt.toISOString(),
  }
}

export async function createDesignRun(args: {
  boardId: string | null
  format: OutputFormat
  brief: string
  clientId: string | null
  kitId: string | null
  kitVersion: number | null
  linearIssue: string | null
  userId: string
}): Promise<string> {
  const id = nanoid()
  await db.insert(schema.designRun).values({
    id,
    boardId: args.boardId,
    format: args.format,
    brief: args.brief,
    clientId: args.clientId,
    kitId: args.kitId,
    kitVersion: args.kitVersion,
    linearIssue: args.linearIssue,
    createdBy: args.userId,
  })
  return id
}

export async function setRunVariants(id: string, variants: DesignVariant[]): Promise<void> {
  await db
    .update(schema.designRun)
    .set({ variants, updatedAt: new Date() })
    .where(eq(schema.designRun.id, id))
}

export async function getDesignRun(id: string): Promise<DesignRun | null> {
  const [row] = await runsQuery().where(eq(schema.designRun.id, id)).limit(1)
  return row ? toDesignRun(row) : null
}

// The newest run that produced this output as one of its variants.
export async function runForOutput(outputId: string): Promise<DesignRun | null> {
  const [row] = await runsQuery()
    .where(sql`${schema.designRun.variants} @> ${JSON.stringify([{ outputId }])}::jsonb`)
    .orderBy(desc(schema.designRun.createdAt))
    .limit(1)
  return row ? toDesignRun(row) : null
}

export async function chooseDesignVariant(
  runId: string,
  outputId: string,
): Promise<{ ok: true; run: DesignRun } | { ok: false; status: 400 | 404; error: string }> {
  const run = await getDesignRun(runId)
  if (!run) return { ok: false, status: 404, error: 'Design run not found' }
  const variant = run.variants.find((v) => v.outputId === outputId && v.status === 'done')
  if (!variant)
    return { ok: false, status: 400, error: 'That output isn’t one of this run’s options' }
  await db
    .update(schema.designRun)
    .set({ chosenOutputId: outputId, updatedAt: new Date() })
    .where(eq(schema.designRun.id, runId))
  return { ok: true, run: (await getDesignRun(runId))! }
}

export function shareLink(token: string): string {
  const base = process.env.PUBLIC_APP_URL ?? 'http://localhost:5173'
  return `${base.replace(/\/$/, '')}/share/output/${token}`
}

// Posts an output to Linear as a comment: share link (created, or moved to
// the latest version) plus the rendered thumbnail. A design-run variant must
// be the picked one; its run's issue is the default target. `runId` names
// the run when the caller knows it (an output reused from the cache belongs
// to several); otherwise the newest run with this output.
export async function postToLinear(args: {
  userId: string
  outputId: string
  issue?: string | null
  runId?: string
}): Promise<
  | {
      ok: true
      commentUrl: string
      issueIdentifier: string
      imageAttached: boolean
      shareUrl: string
      run: DesignRun | null
    }
  | { ok: false; error: string }
> {
  const output = await getOutputSummary(args.outputId)
  if (!output) return { ok: false, error: 'Output not found.' }
  const run = args.runId ? await getDesignRun(args.runId) : await runForOutput(args.outputId)
  const gate = linearPostGate(run, args.outputId, args.issue)
  if (!gate.ok) return gate

  const api = await linearForUser(args.userId, { comment: true })
  const share = (await shareOutput(output.id, args.userId))!
  const shareUrl = shareLink(share.token)
  const thumbnail = await outputThumbnail(output.id, output.latestVersion).catch((e) => {
    console.warn('[linear] thumbnail render failed', e instanceof Error ? e.message : e)
    return null
  })
  const posted = await postOutputComment({
    api,
    issueRef: gate.issue,
    output: {
      id: output.id,
      name: output.name,
      format: output.format,
      clientName: output.clientName,
    },
    shareUrl,
    thumbnail: thumbnail?.png ?? null,
  })
  if (run) {
    await db
      .update(schema.designRun)
      .set({ linearCommentUrl: posted.commentUrl, postedAt: new Date(), updatedAt: new Date() })
      .where(eq(schema.designRun.id, run.id))
  }
  return {
    ok: true,
    ...posted,
    shareUrl,
    run: run ? await getDesignRun(run.id) : null,
  }
}

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

export function dbDesignCache(model: string): DesignCache {
  return {
    async get(key) {
      const [hit] = await db
        .select()
        .from(schema.designCache)
        .where(eq(schema.designCache.cacheKey, key))
        .limit(1)
      const parsed = designVariantSchema.safeParse(hit?.result)
      if (!parsed.success || !parsed.data.outputId) return null
      // The output it pointed at may since have been deleted.
      return (await getOutputSummary(parsed.data.outputId)) ? parsed.data : null
    },
    async put(key, variant) {
      await db
        .insert(schema.designCache)
        .values({ cacheKey: key, model, result: variant })
        .onConflictDoUpdate({
          target: schema.designCache.cacheKey,
          set: { model, result: variant, createdAt: new Date() },
        })
    },
  }
}

const proposalCache: ProposalCache = {
  async get(key) {
    const [row] = await db
      .select()
      .from(schema.designCache)
      .where(eq(schema.designCache.cacheKey, key))
      .limit(1)
    const parsed = z.array(proposedSlotSchema).safeParse(row?.result)
    return parsed.success ? parsed.data : null
  },
  async put(key, slots) {
    await db
      .insert(schema.designCache)
      .values({ cacheKey: key, model: SLOT_PROPOSER_TAG, result: slots })
      .onConflictDoNothing()
  },
}

// Save-as-template's proposer: the model one when ANTHROPIC_API_KEY is
// set, otherwise the document's existing markers.
export function slotProposer(): SlotProposer {
  const client = defaultModelClient()
  return client ? modelSlotProposer(client, proposalCache) : existingMarkers
}

// Every library asset the designer could reach for this client — part of
// its cache key, so a new upload means a fresh design.
export async function clientAssetIds(clientId: string | null): Promise<string[]> {
  const rows = await db
    .select({ id: schema.asset.id })
    .from(schema.asset)
    .where(
      and(
        ne(schema.asset.kind, 'pdf-thumb'),
        clientId ? eq(schema.asset.clientId, clientId) : sql`${schema.asset.clientId} IS NULL`,
      ),
    )
  return rows.map((r) => r.id)
}
