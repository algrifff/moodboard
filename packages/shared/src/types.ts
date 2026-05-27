export type ImageData = { url: string; thumbnailUrl?: string }
export type StickyData = { text: string; color: string }
export type TextData = { text: string; font: string; fontSize: number }
export type PDFData = { url: string; thumbnailUrl: string; extractedText: string }

export type CanvasObjectType = 'image' | 'sticky' | 'text' | 'pdf'

export type CanvasObject = {
  id: string
  type: CanvasObjectType
  position: { x: number; y: number }
  size: { width: number; height: number }
  rotation: number
  zIndex: number
  data: ImageData | StickyData | TextData | PDFData
}

export type AIAnalysis = {
  mood: string
  tone: string
  palette: string[]
  adjectives: string[]
  themes: string[]
  summary: string
}

export type Group = {
  id: string
  objectIds: string[]
  boundingBox: { x: number; y: number; w: number; h: number }
  analysis?: AIAnalysis
  analysisHash?: string
}

export type Board = {
  id: string
  userId: string | null
  name: string
  objects: CanvasObject[]
  groups: Group[]
  createdAt: string
  updatedAt: string
}
