import { describe, expect, it } from 'vitest'
import { extractDriveFileId } from './driveUrl'

describe('extractDriveFileId', () => {
  const id = '1aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789'

  it('extracts from a Google Docs URL', () => {
    expect(extractDriveFileId(`https://docs.google.com/document/d/${id}/edit?usp=share_link`)).toBe(
      id,
    )
  })

  it('extracts from a Sheets URL', () => {
    expect(extractDriveFileId(`https://docs.google.com/spreadsheets/d/${id}/edit?gid=0`)).toBe(id)
  })

  it('extracts from a Slides URL with fragment', () => {
    expect(extractDriveFileId(`https://docs.google.com/presentation/d/${id}/edit#slide=id.p`)).toBe(
      id,
    )
  })

  it('extracts from a Drive file URL', () => {
    expect(extractDriveFileId(`https://drive.google.com/file/d/${id}/view?usp=sharing`)).toBe(id)
  })

  it('extracts from a Drive folder URL', () => {
    expect(extractDriveFileId(`https://drive.google.com/drive/folders/${id}`)).toBe(id)
  })

  it('extracts from an account-scoped folder URL', () => {
    expect(extractDriveFileId(`https://drive.google.com/drive/u/0/folders/${id}`)).toBe(id)
  })

  it('extracts from the legacy ?id= form', () => {
    expect(extractDriveFileId(`https://drive.google.com/open?id=${id}`)).toBe(id)
  })

  it('returns null for non-Drive URLs', () => {
    expect(extractDriveFileId(`https://www.figma.com/file/${id}`)).toBe(null)
  })

  it('returns null for Drive URLs without an id', () => {
    expect(extractDriveFileId('https://drive.google.com/drive/my-drive')).toBe(null)
  })

  it('returns null for invalid URL strings', () => {
    expect(extractDriveFileId('hello world')).toBe(null)
    expect(extractDriveFileId('')).toBe(null)
  })

  it('rejects ids shorter than 25 chars', () => {
    expect(extractDriveFileId('https://drive.google.com/file/d/short/view')).toBe(null)
  })
})
