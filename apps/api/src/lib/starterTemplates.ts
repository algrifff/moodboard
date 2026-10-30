import { slotSchema } from '@moodboard/shared'
import { and, eq } from 'drizzle-orm'
import { nanoid } from 'nanoid'
import { db, schema } from '../db'
import { loadStarterTemplates, type StarterTemplate } from './starterTemplateFiles'

// Starter templates ship as plain files in src/templates/<key>/ (meta.json,
// template.html, template.css, optional template.js) so they read and diff
// like any other source. On boot each one is upserted by key: created if
// missing, and given a new version when the files changed. Versions are
// never rewritten, so outputs made from an older one keep rendering as they
// did.

export async function syncStarterTemplates(
  starters?: StarterTemplate[],
): Promise<{ created: string[]; updated: string[] }> {
  const list = starters ?? (await loadStarterTemplates())
  const created: string[] = []
  const updated: string[] = []
  for (const s of list) {
    await db.transaction(async (tx) => {
      const [existing] = await tx
        .select()
        .from(schema.template)
        .where(eq(schema.template.starterKey, s.key))
        .for('update')
      if (!existing) {
        const id = nanoid()
        const inserted = await tx
          .insert(schema.template)
          .values({
            id,
            name: s.name,
            format: s.format,
            viewport: s.viewport,
            starterKey: s.key,
          })
          .onConflictDoNothing({ target: schema.template.starterKey })
          .returning({ id: schema.template.id })
        // Another instance won the race; it inserts the version too.
        if (inserted.length === 0) return
        await tx.insert(schema.templateVersion).values({
          id: nanoid(),
          templateId: id,
          version: 1,
          html: s.html,
          css: s.css,
          js: s.js,
          slots: slotSchema(s.html),
          note: 'Starter template',
        })
        created.push(s.key)
        return
      }

      const [latest] = await tx
        .select()
        .from(schema.templateVersion)
        .where(
          and(
            eq(schema.templateVersion.templateId, existing.id),
            eq(schema.templateVersion.version, existing.latestVersion),
          ),
        )
        .limit(1)
      const metaChanged =
        existing.name !== s.name ||
        existing.format !== s.format ||
        JSON.stringify(existing.viewport) !== JSON.stringify(s.viewport)
      const contentChanged =
        !latest || latest.html !== s.html || latest.css !== s.css || latest.js !== s.js
      if (!metaChanged && !contentChanged) return

      const version = contentChanged ? existing.latestVersion + 1 : existing.latestVersion
      if (contentChanged) {
        await tx.insert(schema.templateVersion).values({
          id: nanoid(),
          templateId: existing.id,
          version,
          html: s.html,
          css: s.css,
          js: s.js,
          slots: slotSchema(s.html),
          note: 'Starter template updated',
        })
      }
      await tx
        .update(schema.template)
        .set({
          name: s.name,
          format: s.format,
          viewport: s.viewport,
          latestVersion: version,
          updatedAt: new Date(),
        })
        .where(eq(schema.template.id, existing.id))
      updated.push(s.key)
    })
  }
  return { created, updated }
}
