import { matchNamed, type TemplateSummary } from '@moodboard/shared'
import { searchAssets } from './assetLibrary'
import type { DesignToolbox, ToolResult } from './designer'
import { RenderTimeoutError } from './renderFrame'
import { renderOutputFrame } from './outputRender'
import { addOutputVersion, createOutput, getOutputDetail } from './outputs'
import { editOutputDocument } from './outputTools'
import { loadReferenceImage, referenceText, type FigmaReference } from './figmaTools'

// The designer's tools against the real thing: outputs in Postgres (every
// edit a new version), the client's library, and the frame renderer. One
// toolbox per variant; the variant loop (designer.ts) owns the rules about
// when each may be called.

const json = (value: unknown) => JSON.stringify(value)

export function designToolbox(args: {
  boardId: string
  userId: string
  clientId: string | null
  kitId: string | null
  templates: TemplateSummary[]
  figmaFrames?: FigmaReference[]
}): DesignToolbox {
  const fail = (error: string): ToolResult<never> => ({ ok: false, error })

  return {
    async searchAssets({ query, kind, limit }) {
      const { assets } = await searchAssets({
        q: query,
        client: args.clientId ?? undefined,
        kind,
        limit: limit ?? 10,
        offset: 0,
      })
      return {
        ok: true,
        text: json(
          assets.map((a) => ({
            name: a.name,
            url: a.url,
            kind: a.kind,
            caption: a.caption,
            tags: a.tags,
            colors: a.colors,
            width: a.width,
            height: a.height,
          })),
        ),
      }
    },

    async createOutput({ template, name, slots }) {
      const m = matchNamed(args.templates, template)
      if (m.kind !== 'found') {
        return fail(
          `No template “${template}” for this format. Use one of: ${args.templates.map((t) => t.name).join(', ')}.`,
        )
      }
      const result = await createOutput({
        templateId: m.item.id,
        clientId: args.clientId,
        kitId: args.kitId,
        name,
        slotValues: slots,
        boardId: args.boardId,
        userId: args.userId,
      })
      if (!result.ok) return fail(result.error)
      const detail = (await getOutputDetail(result.output.id))!
      return {
        ok: true,
        outputId: result.output.id,
        version: 1,
        template: m.item.name,
        text: json({
          created: name,
          version: 1,
          slots: detail.version.slots.map((s) => ({
            name: s.name,
            kind: s.kind,
            value: s.value ?? `(default) ${s.defaultValue.slice(0, 120)}`,
          })),
        }),
      }
    },

    async getSource(outputId) {
      const detail = await getOutputDetail(outputId)
      if (!detail) return fail('Output not found.')
      return {
        ok: true,
        text: json({
          version: detail.version.version,
          html: detail.version.html,
          css: detail.version.css,
          slotValues: detail.version.slotValues,
        }),
      }
    },

    async updateSlots(outputId, slots, baseVersion) {
      const result = await addOutputVersion({
        outputId,
        patch: { baseVersion, slotValues: slots },
        userId: args.userId,
      })
      if (!result.ok) {
        return fail(
          result.status === 409
            ? `Someone else saved v${result.latest} — stop editing and finish with what you have.`
            : result.error,
        )
      }
      return { ok: true, version: result.version, text: `Saved v${result.version}.` }
    },

    async updateHtml(outputId, edits, baseVersion) {
      const result = await editOutputDocument({
        outputId,
        html: edits.html,
        css: edits.css,
        baseVersion,
        userId: args.userId,
      })
      if (!result.ok) return fail(result.error)
      return { ok: true, version: result.version, text: `Saved v${result.version}.` }
    },

    async getFigmaFrame(frame) {
      const frames = args.figmaFrames ?? []
      const m = matchNamed(
        frames.map((f) => ({ id: f.objectId, name: f.name, ref: f })),
        frame,
      )
      if (m.kind !== 'found') {
        return fail(
          `No attached Figma frame “${frame}”. Attached: ${frames.map((f) => f.name).join(', ') || 'none'}.`,
        )
      }
      const ref = m.item.ref
      const image = await loadReferenceImage(ref)
      return { ok: true, png: image?.png ?? null, text: referenceText(ref) }
    },

    async render(outputId, version, { section }) {
      try {
        const frame = await renderOutputFrame(outputId, { version, section })
        if (!frame) return fail('Output not found.')
        return {
          ok: true,
          png: frame.png,
          sections: frame.sections,
          width: frame.width,
          height: frame.height,
          text: json({
            version,
            size: `${frame.viewport.width}×${frame.viewport.height}`,
            ...(section !== undefined ? { section } : {}),
            sections: frame.sections,
            ...(frame.missingAssets.length > 0 ? { missingAssets: frame.missingAssets } : {}),
            ...(frame.errors.length > 0 ? { pageErrors: frame.errors.slice(0, 5) } : {}),
          }),
        }
      } catch (e) {
        if (e instanceof RenderTimeoutError)
          return fail('The render timed out. Simplify and retry.')
        return fail(`Render failed: ${e instanceof Error ? e.message : String(e)}`)
      }
    },
  }
}
