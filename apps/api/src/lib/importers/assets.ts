import { nanoid } from 'nanoid'
import { db, schema } from '../../db'

// Inline asset insert so we don't depend on files.ts. Same shape as the
// helper there; kept tiny because all the validation is upstream (we know
// the file came from a verified Drive call, not a user upload).
export async function recordAsset(
  userId: string,
  filename: string,
  mimeType: string,
  size: number,
  kind: 'upload' | 'pdf' | 'pdf-thumb',
): Promise<void> {
  await db.insert(schema.asset).values({
    id: nanoid(),
    createdBy: userId,
    filename,
    mimeType,
    size,
    kind,
  })
}
