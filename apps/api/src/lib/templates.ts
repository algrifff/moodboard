import {
  outputFormatSchema,
  slotSchema,
  templateViewportSchema,
  type OutputFormat,
  type TemplateDetail,
  type TemplateSlot,
  type TemplateSummary,
  type TemplateViewport,
  type VersionMeta,
} from '@moodboard/shared'
import { and, asc, desc, eq, sql } from 'drizzle-orm'
import { nanoid } from 'nanoid'
import { db, schema } from '../db'

// Templates: style-agnostic HTML + CSS with data-slot markers, edited by
// appending immutable versions (the template row points at its latest).
// Slot labels live in the HTML as `data-slot-label`, so the document is the
// one source of truth; the `slots` column is that schema, cached.

type TemplateRow = typeof schema.template.$inferSelect

function parseSlots(raw: unknown): TemplateSlot[] {
  return Array.isArray(raw) ? (raw as TemplateSlot[]) : []
}

export function parseViewport(raw: unknown): TemplateViewport {
  const parsed = templateViewportSchema.safeParse(raw)
  return parsed.success ? parsed.data : { kind: 'responsive' }
}

export function parseFormat(raw: string): OutputFormat {
  const parsed = outputFormatSchema.safeParse(raw)
  return parsed.success ? parsed.data : 'other'
}

const summarySelect = {
  template: schema.template,
  clientName: schema.client.name,
  slots: schema.templateVersion.slots,
}

function summariesQuery() {
  return db
    .select(summarySelect)
    .from(schema.template)
    .leftJoin(schema.client, eq(schema.client.id, schema.template.clientId))
    .innerJoin(
      schema.templateVersion,
      and(
        eq(schema.templateVersion.templateId, schema.template.id),
        eq(schema.templateVersion.version, schema.template.latestVersion),
      ),
    )
}

function toSummary(row: {
  template: TemplateRow
  clientName: string | null
  slots: unknown
}): TemplateSummary {
  const t = row.template
  return {
    id: t.id,
    name: t.name,
    format: parseFormat(t.format),
    viewport: parseViewport(t.viewport),
    clientId: t.clientId,
    clientName: row.clientName,
    starter: t.starterKey !== null,
    latestVersion: t.latestVersion,
    slots: parseSlots(row.slots),
    updatedAt: t.updatedAt.toISOString(),
  }
}

// Starters first (in their shipped order), then the team's own, newest first.
export async function listTemplates(
  filter: { clientId?: string; format?: OutputFormat } = {},
): Promise<TemplateSummary[]> {
  const rows = await summariesQuery()
    .where(
      and(
        filter.clientId
          ? sql`(${schema.template.clientId} = ${filter.clientId} OR ${schema.template.clientId} IS NULL)`
          : undefined,
        filter.format ? eq(schema.template.format, filter.format) : undefined,
      ),
    )
    .orderBy(
      sql`${schema.template.starterKey} IS NULL`,
      asc(schema.template.createdAt),
      desc(schema.template.updatedAt),
    )
  return rows.map(toSummary)
}

export async function getTemplateSummary(id: string): Promise<TemplateSummary | null> {
  const [row] = await summariesQuery().where(eq(schema.template.id, id)).limit(1)
  return row ? toSummary(row) : null
}

export type TemplateVersionRow = typeof schema.templateVersion.$inferSelect

export async function getTemplateVersion(
  id: string,
  version?: number,
): Promise<{ template: TemplateSummary; row: TemplateVersionRow } | null> {
  const template = await getTemplateSummary(id)
  if (!template) return null
  const [row] = await db
    .select()
    .from(schema.templateVersion)
    .where(
      and(
        eq(schema.templateVersion.templateId, id),
        eq(schema.templateVersion.version, version ?? template.latestVersion),
      ),
    )
    .limit(1)
  return row ? { template, row } : null
}

async function versionMetas(templateId: string): Promise<VersionMeta[]> {
  const rows = await db
    .select({
      version: schema.templateVersion.version,
      note: schema.templateVersion.note,
      createdAt: schema.templateVersion.createdAt,
      createdByName: schema.user.name,
    })
    .from(schema.templateVersion)
    .leftJoin(schema.user, eq(schema.user.id, schema.templateVersion.createdBy))
    .where(eq(schema.templateVersion.templateId, templateId))
    .orderBy(desc(schema.templateVersion.version))
  return rows.map((r) => ({ ...r, createdAt: r.createdAt.toISOString() }))
}

export async function getTemplateDetail(
  id: string,
  version?: number,
): Promise<TemplateDetail | null> {
  const found = await getTemplateVersion(id, version)
  if (!found) return null
  const versions = await versionMetas(id)
  const meta = versions.find((v) => v.version === found.row.version)!
  return {
    template: found.template,
    version: {
      ...meta,
      html: found.row.html,
      css: found.row.css,
      js: found.row.js,
      slots: parseSlots(found.row.slots),
    },
    versions,
  }
}

export async function createTemplate(args: {
  name: string
  format: OutputFormat
  viewport: TemplateViewport
  clientId: string | null
  html: string
  css: string
  js: string
  note?: string
  userId: string | null
}): Promise<TemplateSummary> {
  const id = nanoid()
  await db.transaction(async (tx) => {
    await tx.insert(schema.template).values({
      id,
      name: args.name,
      format: args.format,
      viewport: args.viewport,
      clientId: args.clientId,
      createdBy: args.userId,
    })
    await tx.insert(schema.templateVersion).values({
      id: nanoid(),
      templateId: id,
      version: 1,
      html: args.html,
      css: args.css,
      js: args.js,
      slots: slotSchema(args.html),
      note: args.note ?? '',
      createdBy: args.userId,
    })
  })
  return (await getTemplateSummary(id))!
}

export async function updateTemplate(
  id: string,
  patch: { name?: string; clientId?: string | null },
): Promise<TemplateSummary | null> {
  const rows = await db
    .update(schema.template)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(schema.template.id, id))
    .returning({ id: schema.template.id })
  return rows.length > 0 ? getTemplateSummary(id) : null
}

export type DeleteTemplateResult = 'deleted' | 'not-found' | 'starter'

// Starters come back on the next boot, so deleting one would only confuse.
// Outputs made from a deleted template keep their own copy of the document.
export async function deleteTemplate(id: string): Promise<DeleteTemplateResult> {
  const [row] = await db
    .select({ starterKey: schema.template.starterKey })
    .from(schema.template)
    .where(eq(schema.template.id, id))
    .limit(1)
  if (!row) return 'not-found'
  if (row.starterKey !== null) return 'starter'
  await db.delete(schema.template).where(eq(schema.template.id, id))
  return 'deleted'
}
