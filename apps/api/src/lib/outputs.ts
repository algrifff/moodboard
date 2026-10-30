import {
  fileRefs,
  findSlots,
  humanizeSlotName,
  invalidSlotValues,
  isSafeKitUrl,
  kitToCss,
  parseVideoDoc,
  HOUSE_KIT_TOKENS,
  slotValuesSchema,
  viewportSize,
  type CanvasObject,
  type CreateOutputVersionRequest,
  type KitTokens,
  type OutputCardData,
  type OutputDetail,
  type OutputShare,
  type OutputSlot,
  type OutputSummary,
  type OutputVersionMeta,
  type SlotValues,
} from '@moodboard/shared'
import { and, desc, eq, sql } from 'drizzle-orm'
import { alias } from 'drizzle-orm/pg-core'
import { nanoid } from 'nanoid'
import { db, schema } from '../db'
import { insertBoardObject, loadBoardObjects, type VersionedObject } from './boardObjects'
import { nextSpot } from './canvasPlacement'
import { composeDocument, type Composed } from './compose'
import { loadInlineAssets } from './inlineAssets'
import { getKitDetail, getKitSummary } from './kits'
import { getTemplateVersion, parseFormat, parseViewport } from './templates'

// Outputs: a template instantiated for a client, skinned with a kit, slots
// filled. Every edit appends an immutable version holding the whole
// document (html + css as edited, slot values, kit version), so any version
// renders exactly as it did.

const pinnedKit = alias(schema.styleKit, 'pinned_kit')
const creator = alias(schema.user, 'output_creator')

function summarySelect() {
  return {
    output: schema.output,
    clientName: schema.client.name,
    templateName: schema.template.name,
    kitId: schema.outputVersion.kitId,
    kitName: pinnedKit.name,
    createdByName: creator.name,
  }
}

function summariesQuery() {
  return db
    .select(summarySelect())
    .from(schema.output)
    .leftJoin(schema.client, eq(schema.client.id, schema.output.clientId))
    .leftJoin(schema.template, eq(schema.template.id, schema.output.templateId))
    .innerJoin(
      schema.outputVersion,
      and(
        eq(schema.outputVersion.outputId, schema.output.id),
        eq(schema.outputVersion.version, schema.output.latestVersion),
      ),
    )
    .leftJoin(pinnedKit, eq(pinnedKit.id, schema.outputVersion.kitId))
    .leftJoin(creator, eq(creator.id, schema.output.createdBy))
}

type SummaryRow = Awaited<ReturnType<ReturnType<typeof summariesQuery>['limit']>>[number]

function toSummary(row: SummaryRow): OutputSummary {
  const o = row.output
  return {
    id: o.id,
    name: o.name,
    format: parseFormat(o.format),
    viewport: parseViewport(o.viewport),
    clientId: o.clientId,
    clientName: row.clientName,
    boardId: o.boardId,
    templateId: o.templateId,
    templateName: row.templateName,
    kitId: row.kitId,
    kitName: row.kitName,
    latestVersion: o.latestVersion,
    createdByName: row.createdByName,
    updatedAt: o.updatedAt.toISOString(),
  }
}

// `clientId: null` lists the outputs without a client.
export async function listOutputs(
  filter: { clientId?: string | null; boardId?: string } = {},
): Promise<OutputSummary[]> {
  const rows = await summariesQuery()
    .where(
      and(
        filter.clientId === null
          ? sql`${schema.output.clientId} IS NULL`
          : filter.clientId
            ? eq(schema.output.clientId, filter.clientId)
            : undefined,
        filter.boardId ? eq(schema.output.boardId, filter.boardId) : undefined,
      ),
    )
    .orderBy(desc(schema.output.updatedAt))
    .limit(200)
  return rows.map(toSummary)
}

export async function getOutputSummary(id: string): Promise<OutputSummary | null> {
  const [row] = await summariesQuery().where(eq(schema.output.id, id)).limit(1)
  return row ? toSummary(row) : null
}

type VersionRow = typeof schema.outputVersion.$inferSelect

async function versionRow(outputId: string, version: number): Promise<VersionRow | null> {
  const [row] = await db
    .select()
    .from(schema.outputVersion)
    .where(
      and(eq(schema.outputVersion.outputId, outputId), eq(schema.outputVersion.version, version)),
    )
    .limit(1)
  return row ?? null
}

function parseValues(raw: unknown): SlotValues {
  const parsed = slotValuesSchema.safeParse(raw)
  return parsed.success ? parsed.data : {}
}

export function outputSlots(html: string, values: SlotValues): OutputSlot[] {
  return findSlots(html).map((m) => ({
    name: m.name,
    kind: m.kind,
    label: m.label ?? humanizeSlotName(m.name),
    value: Object.prototype.hasOwnProperty.call(values, m.name) ? values[m.name]! : null,
    defaultValue: m.defaultValue,
  }))
}

async function versionMetas(outputId: string): Promise<OutputVersionMeta[]> {
  const rows = await db
    .select({
      version: schema.outputVersion.version,
      note: schema.outputVersion.note,
      createdAt: schema.outputVersion.createdAt,
      createdByName: schema.user.name,
      kitId: schema.outputVersion.kitId,
      kitVersion: schema.outputVersion.kitVersion,
    })
    .from(schema.outputVersion)
    .leftJoin(schema.user, eq(schema.user.id, schema.outputVersion.createdBy))
    .where(eq(schema.outputVersion.outputId, outputId))
    .orderBy(desc(schema.outputVersion.version))
  return rows.map((r) => ({ ...r, createdAt: r.createdAt.toISOString() }))
}

export async function getOutputShare(outputId: string): Promise<OutputShare | null> {
  const [row] = await db
    .select()
    .from(schema.outputShare)
    .where(eq(schema.outputShare.outputId, outputId))
    .limit(1)
  return row
    ? {
        token: row.token,
        version: row.version,
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
      }
    : null
}

export async function getOutputDetail(id: string, version?: number): Promise<OutputDetail | null> {
  const output = await getOutputSummary(id)
  if (!output) return null
  const row = await versionRow(id, version ?? output.latestVersion)
  if (!row) return null
  const [versions, share, kit] = await Promise.all([
    versionMetas(id),
    getOutputShare(id),
    row.kitId ? getKitSummary(row.kitId) : Promise.resolve(null),
  ])
  const meta = versions.find((v) => v.version === row.version)!
  const values = parseValues(row.slotValues)
  return {
    output,
    version: {
      ...meta,
      templateVersion: row.templateVersion,
      slotValues: values,
      html: row.html,
      css: row.css,
      slots: outputSlots(row.html, values),
      kitLatestVersion: kit?.latestVersion ?? null,
      video: parseVideoDoc(row.html),
    },
    versions,
    share,
  }
}

export type OutputFailure = { ok: false; status: 400 | 404 | 409; error: string; latest?: number }

async function kitPin(
  kitId: string | null,
): Promise<{ kitId: string | null; kitVersion: number | null } | null> {
  if (!kitId) return { kitId: null, kitVersion: null }
  const kit = await getKitSummary(kitId)
  return kit ? { kitId: kit.id, kitVersion: kit.latestVersion } : null
}

export async function createOutput(args: {
  templateId: string
  clientId: string | null
  kitId: string | null
  name?: string
  slotValues?: SlotValues
  boardId?: string | null
  userId: string
}): Promise<{ ok: true; output: OutputSummary } | OutputFailure> {
  const found = await getTemplateVersion(args.templateId)
  if (!found) return { ok: false, status: 404, error: 'Template not found' }
  const { template, row } = found
  const pin = await kitPin(args.kitId)
  if (!pin) return { ok: false, status: 404, error: 'Kit not found' }
  const values = args.slotValues ?? {}
  const invalid = invalidSlotValues(findSlots(row.html), values)
  if (invalid.length > 0) return { ok: false, status: 400, error: invalid.join('; ') }

  const id = nanoid()
  await db.transaction(async (tx) => {
    await tx.insert(schema.output).values({
      id,
      name: args.name ?? template.name,
      format: template.format,
      viewport: template.viewport,
      clientId: args.clientId,
      boardId: args.boardId ?? null,
      templateId: template.id,
      createdBy: args.userId,
    })
    await tx.insert(schema.outputVersion).values({
      id: nanoid(),
      outputId: id,
      version: 1,
      templateVersion: row.version,
      ...pin,
      slotValues: values,
      html: row.html,
      css: row.css,
      js: row.js,
      note: `From ${template.name} v${row.version}`,
      createdBy: args.userId,
    })
  })
  return { ok: true, output: (await getOutputSummary(id))! }
}

function changeNote(
  patch: CreateOutputVersionRequest,
  labels: Map<string, string>,
  kitName: string | null,
): string {
  const parts: string[] = []
  const edited = Object.keys(patch.slotValues ?? {})
  if (edited.length > 0) {
    const names = edited.map((n) => labels.get(n) ?? humanizeSlotName(n))
    parts.push(
      `Edited ${names.slice(0, 3).join(', ')}${names.length > 3 ? ` +${names.length - 3}` : ''}`,
    )
  }
  if (patch.kitId !== undefined) parts.push(kitName ? `Kit: ${kitName}` : 'No kit')
  if (patch.html !== undefined || patch.css !== undefined) parts.push('Edited HTML/CSS')
  return parts.join(' · ') || 'Saved'
}

// Appends a version on top of `baseVersion`, which must still be the latest
// (a teammate's newer save is a 409, never buried). Bumping latest_version
// under the row lock serialises concurrent saves.
export async function addOutputVersion(args: {
  outputId: string
  patch: CreateOutputVersionRequest
  userId: string
}): Promise<{ ok: true; version: number } | OutputFailure> {
  const { patch } = args
  let pin: { kitId: string | null; kitVersion: number | null } | undefined
  let kitName: string | null = null
  if (patch.kitId !== undefined) {
    const found = await kitPin(patch.kitId)
    if (!found) return { ok: false, status: 404, error: 'Kit not found' }
    pin = found
    kitName = patch.kitId ? ((await getKitSummary(patch.kitId))?.name ?? null) : null
  }

  return db.transaction(async (tx) => {
    const [out] = await tx
      .select({ latest: schema.output.latestVersion })
      .from(schema.output)
      .where(eq(schema.output.id, args.outputId))
      .for('update')
    if (!out) return { ok: false, status: 404, error: 'Not found' } as const
    if (patch.baseVersion !== out.latest) {
      return {
        ok: false,
        status: 409,
        error: 'A teammate saved a newer version while you were editing',
        latest: out.latest,
      } as const
    }
    const from = patch.restoreVersion ?? out.latest
    const [base] = await tx
      .select()
      .from(schema.outputVersion)
      .where(
        and(
          eq(schema.outputVersion.outputId, args.outputId),
          eq(schema.outputVersion.version, from),
        ),
      )
      .limit(1)
    if (!base) return { ok: false, status: 404, error: `No version ${from}` } as const

    let next: Omit<VersionRow, 'id' | 'outputId' | 'version' | 'createdBy' | 'createdAt'>
    if (patch.restoreVersion !== undefined) {
      next = {
        templateVersion: base.templateVersion,
        kitId: base.kitId,
        kitVersion: base.kitVersion,
        slotValues: base.slotValues,
        html: base.html,
        css: base.css,
        js: base.js,
        note: patch.note || `Restored v${from}`,
      }
    } else {
      const html = patch.html ?? base.html
      const values: Record<string, string> = { ...parseValues(base.slotValues) }
      for (const [name, value] of Object.entries(patch.slotValues ?? {})) {
        if (value === null) delete values[name]
        else values[name] = value
      }
      const markers = findSlots(html)
      const invalid = invalidSlotValues(markers, patch.slotValues ?? {})
      if (invalid.length > 0) return { ok: false, status: 400, error: invalid.join('; ') } as const
      const labels = new Map(markers.map((m) => [m.name, m.label ?? humanizeSlotName(m.name)]))
      next = {
        templateVersion: base.templateVersion,
        kitId: pin ? pin.kitId : base.kitId,
        kitVersion: pin ? pin.kitVersion : base.kitVersion,
        slotValues: values,
        html,
        css: patch.css ?? base.css,
        js: base.js,
        note: patch.note || changeNote(patch, labels, kitName),
      }
    }

    const version = out.latest + 1
    await tx.insert(schema.outputVersion).values({
      ...next,
      id: nanoid(),
      outputId: args.outputId,
      version,
      createdBy: args.userId,
    })
    await tx
      .update(schema.output)
      .set({ latestVersion: version, updatedAt: new Date() })
      .where(eq(schema.output.id, args.outputId))
    return { ok: true, version } as const
  })
}

export async function updateOutput(
  id: string,
  patch: { name?: string; clientId?: string | null; boardId?: string | null },
): Promise<OutputSummary | null> {
  const rows = await db
    .update(schema.output)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(schema.output.id, id))
    .returning({ id: schema.output.id })
  return rows.length > 0 ? getOutputSummary(id) : null
}

export async function deleteOutput(id: string): Promise<boolean> {
  const rows = await db
    .delete(schema.output)
    .where(eq(schema.output.id, id))
    .returning({ id: schema.output.id })
  return rows.length > 0
}

// ---------------------------------------------------------------------------
// Composition
// ---------------------------------------------------------------------------

async function kitTokens(kitId: string | null, kitVersion: number | null): Promise<KitTokens> {
  if (!kitId) return HOUSE_KIT_TOKENS
  const detail = await getKitDetail(kitId, kitVersion ?? undefined)
  return detail?.version.tokens ?? HOUSE_KIT_TOKENS
}

export type RenderDoc = {
  title: string
  format: string
  viewport: OutputSummary['viewport']
  html: string
  css: string
  js: string
  values: SlotValues
  tokens: KitTokens
}

export async function composeDoc(
  doc: RenderDoc,
  opts: { editable?: boolean } = {},
): Promise<Composed> {
  const kitCss = kitToCss(doc.tokens)
  const assets = await loadInlineAssets(
    fileRefs(doc.html, doc.css, kitCss, ...Object.values(doc.values)),
  )
  return composeDocument({
    title: doc.title,
    format: doc.format,
    viewport: doc.viewport,
    html: doc.html,
    css: doc.css,
    js: doc.js,
    kitCss,
    kitHasLogo: doc.tokens.logos.some((l) => isSafeKitUrl(l.url)),
    values: doc.values,
    assets,
    editable: opts.editable,
  })
}

export async function outputRenderDoc(id: string, version?: number): Promise<RenderDoc | null> {
  const output = await getOutputSummary(id)
  if (!output) return null
  const row = await versionRow(id, version ?? output.latestVersion)
  if (!row) return null
  return {
    title: output.name,
    format: output.format,
    viewport: output.viewport,
    html: row.html,
    css: row.css,
    js: row.js,
    values: parseValues(row.slotValues),
    tokens: await kitTokens(row.kitId, row.kitVersion),
  }
}

export async function templateRenderDoc(
  id: string,
  opts: { version?: number; kitId?: string },
): Promise<RenderDoc | null> {
  const found = await getTemplateVersion(id, opts.version)
  if (!found) return null
  return {
    title: found.template.name,
    format: found.template.format,
    viewport: found.template.viewport,
    html: found.row.html,
    css: found.row.css,
    js: found.row.js,
    values: {},
    tokens: await kitTokens(opts.kitId ?? null, null),
  }
}

export function downloadName(name: string): string {
  return `${
    name
      .replace(/[^a-zA-Z0-9 _.-]/g, '')
      .trim()
      .slice(0, 80) || 'output'
  }.html`
}

// ---------------------------------------------------------------------------
// Share links (Phase 18's token mechanism, pinned to a version)
// ---------------------------------------------------------------------------

const TOKEN_LENGTH = 32

// Create or move the pin to the latest version. The token never changes, so
// recipients keep their link.
export async function shareOutput(outputId: string, userId: string): Promise<OutputShare | null> {
  const output = await getOutputSummary(outputId)
  if (!output) return null
  const now = new Date()
  await db
    .insert(schema.outputShare)
    .values({
      token: nanoid(TOKEN_LENGTH),
      outputId,
      version: output.latestVersion,
      createdBy: userId,
    })
    .onConflictDoUpdate({
      target: schema.outputShare.outputId,
      set: { version: output.latestVersion, updatedAt: now },
    })
  return getOutputShare(outputId)
}

export async function unshareOutput(outputId: string): Promise<boolean> {
  const rows = await db
    .delete(schema.outputShare)
    .where(eq(schema.outputShare.outputId, outputId))
    .returning({ token: schema.outputShare.token })
  return rows.length > 0
}

export async function getSharedOutput(token: string) {
  const [row] = await db
    .select({
      share: schema.outputShare,
      name: schema.output.name,
      format: schema.output.format,
      viewport: schema.output.viewport,
    })
    .from(schema.outputShare)
    .innerJoin(schema.output, eq(schema.output.id, schema.outputShare.outputId))
    .where(eq(schema.outputShare.token, token))
    .limit(1)
  if (!row) return null
  return {
    outputId: row.share.outputId,
    view: {
      token: row.share.token,
      name: row.name,
      format: parseFormat(row.format),
      viewport: parseViewport(row.viewport),
      version: row.share.version,
      updatedAt: row.share.updatedAt.toISOString(),
      video: null,
    },
  }
}

// ---------------------------------------------------------------------------
// Board cards
// ---------------------------------------------------------------------------

const CARD_FOOTER_PX = 34

export function outputCardSize(viewport: OutputSummary['viewport']): {
  width: number
  height: number
} {
  const natural = viewportSize(viewport)
  const width = natural.height > natural.width ? 280 : 360
  return { width, height: Math.round((width * natural.height) / natural.width) + CARD_FOOTER_PX }
}

export async function placeOutputOnBoard(args: {
  outputId: string
  boardId: string
  userId: string
  at?: { x: number; y: number }
}): Promise<{ ok: true; added: VersionedObject } | OutputFailure> {
  const output = await getOutputSummary(args.outputId)
  if (!output) return { ok: false, status: 404, error: 'Output not found' }
  const [board] = await db
    .select({ id: schema.board.id })
    .from(schema.board)
    .where(eq(schema.board.id, args.boardId))
    .limit(1)
  if (!board) return { ok: false, status: 404, error: 'Board not found' }

  const natural = viewportSize(output.viewport)
  const size = outputCardSize(output.viewport)
  const existing = (await loadBoardObjects(args.boardId)).map((v) => v.object)
  const data: OutputCardData = {
    outputId: output.id,
    name: output.name,
    format: output.format,
    width: natural.width,
    height: natural.height,
  }
  const object: CanvasObject = {
    id: nanoid(),
    type: 'output',
    position: args.at
      ? { x: args.at.x - size.width / 2, y: args.at.y - size.height / 2 }
      : nextSpot(existing, size),
    size,
    rotation: 0,
    zIndex: existing.length,
    data,
  }
  await insertBoardObject(args.boardId, object, args.userId)
  if (!output.boardId) await updateOutput(output.id, { boardId: args.boardId })
  return { ok: true, added: { object, version: 1 } }
}
