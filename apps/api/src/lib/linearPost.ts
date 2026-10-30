import { OUTPUT_FORMAT_LABELS, type OutputFormat } from '@moodboard/shared'
import { LinearApiError, linearApi, uploadToLinear, type FetchLike } from './linear'

// Posting a design back to the Linear issue it came from. Manual only: the
// person picks a variant (or asks for a specific output to be posted), and
// the gate below refuses any variant nobody picked. Pure apart from the
// injected Linear client and fetch, so it is tested with fixture responses.

export type RunForPost = { chosenOutputId: string | null; linearIssue: string | null }

// `run` is the design run the output was a variant of (null for an output
// made by hand). `issue` is what the caller named, if anything.
export function linearPostGate(
  run: RunForPost | null,
  outputId: string,
  issue?: string | null,
): { ok: true; issue: string } | { ok: false; error: string } {
  if (run && run.chosenOutputId !== outputId) {
    return {
      ok: false,
      error:
        run.chosenOutputId === null
          ? 'Nothing has been picked yet. Pick an option first — only the picked one goes to Linear.'
          : 'That option wasn’t the one picked. Pick it first, or post the picked one.',
    }
  }
  const target = issue?.trim() || run?.linearIssue
  if (!target) {
    return {
      ok: false,
      error: 'Which Linear issue should it go on? Give an identifier like LIN-123.',
    }
  }
  return { ok: true, issue: target }
}

export function designCommentBody(args: {
  name: string
  format: OutputFormat
  clientName: string | null
  shareUrl: string
  imageUrl: string | null
}): string {
  const what = `${OUTPUT_FORMAT_LABELS[args.format]}${args.clientName ? ` for ${args.clientName}` : ''}`
  return [
    `**${args.name.replace(/[*_`[\]]/g, '')}** — ${what}`,
    ...(args.imageUrl ? ['', `![${what}](${args.imageUrl})`] : []),
    '',
    `[Open the design](${args.shareUrl})`,
    '',
    '_Posted from moodboard.ai_',
  ].join('\n')
}

export async function postOutputComment(args: {
  api: ReturnType<typeof linearApi>
  fetchImpl?: FetchLike
  issueRef: string
  output: { id: string; name: string; format: OutputFormat; clientName: string | null }
  shareUrl: string
  thumbnail: Buffer | null
}): Promise<{ commentUrl: string; issueIdentifier: string; imageAttached: boolean }> {
  const issue = await args.api.issue(args.issueRef)
  if (!issue) throw new LinearApiError(404, `No Linear issue matches “${args.issueRef}”`)

  // The picture is a nice-to-have: a failed upload still posts the link.
  let imageUrl: string | null = null
  if (args.thumbnail) {
    try {
      imageUrl = await uploadToLinear(
        args.api,
        { bytes: args.thumbnail, contentType: 'image/png', filename: `${args.output.id}.png` },
        args.fetchImpl,
      )
    } catch (e) {
      console.warn('[linear] thumbnail upload failed', e instanceof Error ? e.message : e)
    }
  }
  const comment = await args.api.commentCreate(
    issue.id,
    designCommentBody({
      name: args.output.name,
      format: args.output.format,
      clientName: args.output.clientName,
      shareUrl: args.shareUrl,
      imageUrl,
    }),
  )
  return { commentUrl: comment.url, issueIdentifier: issue.identifier, imageAttached: !!imageUrl }
}
