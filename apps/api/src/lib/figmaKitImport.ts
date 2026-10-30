import {
  kitFromFigma,
  mergeFigmaIntoKit,
  type FigmaKitResponse,
  type KitTokens,
} from '@moodboard/shared'
import type { FigmaApi } from './figma'
import { readKitInput } from './figmaStyles'
import { addKitVersion, createKit, getKitDetail } from './kits'

// "Create a style kit from a Figma file": read its styles and variables, map
// them to kit tokens, and either hand back the mapping (preview) or land it
// as a new kit or as a new version of an existing one. Versions are
// immutable; a stale baseVersion is refused like any other kit save.

export type FigmaKitOutcome =
  | { ok: true; result: FigmaKitResponse }
  | {
      ok: false
      status: 404 | 409 | 400
      error: string
      latest?: number
    }

export async function figmaKitFromFile(
  api: FigmaApi,
  args: {
    fileKey: string
    userId: string
    clientId?: string
    kitId?: string
    name?: string
    preview?: boolean
    baseVersion?: number
  },
): Promise<FigmaKitOutcome> {
  const input = await readKitInput(api, args.fileKey)
  const mapped = kitFromFigma(input)
  const note = `Figma import: ${input.fileName}`.slice(0, 200)

  const respond = (
    saved: boolean,
    tokens: KitTokens,
    kit: FigmaKitResponse['kit'],
    version: number | null,
  ): FigmaKitOutcome => ({
    ok: true,
    result: {
      saved,
      fileName: input.fileName,
      tokens,
      report: mapped.report,
      kit,
      version: version === null ? null : { version },
    },
  })

  if (args.kitId) {
    const detail = await getKitDetail(args.kitId)
    if (!detail) return { ok: false, status: 404, error: 'Kit not found.' }
    const merged = mergeFigmaIntoKit(detail.version.tokens, mapped.tokens)
    if (args.preview) return respond(false, merged, detail.kit, null)
    const added = await addKitVersion({
      kitId: args.kitId,
      tokens: merged,
      note,
      baseVersion: args.baseVersion ?? detail.kit.latestVersion,
      userId: args.userId,
    })
    if (!added.ok) {
      return added.reason === 'not-found'
        ? { ok: false, status: 404, error: 'Kit not found.' }
        : {
            ok: false,
            status: 409,
            error: `Someone saved v${added.latest} of this kit meanwhile; try again.`,
            latest: added.latest,
          }
    }
    const fresh = await getKitDetail(args.kitId)
    return respond(true, merged, fresh?.kit ?? detail.kit, added.version)
  }

  if (args.preview) return respond(false, mapped.tokens, null, null)
  if (!args.clientId) {
    return { ok: false, status: 400, error: 'Pick the client this kit is for.' }
  }
  const kit = await createKit({
    clientId: args.clientId,
    name: (args.name ?? input.fileName).slice(0, 80),
    tokens: mapped.tokens,
    note,
    userId: args.userId,
  })
  return respond(true, mapped.tokens, kit, 1)
}
