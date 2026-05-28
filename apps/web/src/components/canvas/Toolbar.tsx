import type { PDFData } from '@moodboard/shared'
import {
  FilePdf,
  Image as ImageIcon,
  NoteBlank,
  TextT,
  Trash,
  type Icon,
} from '@phosphor-icons/react'
import { motion } from 'framer-motion'
import { useRef } from 'react'
import { uploadFile } from '@/lib/api'
import { fitToDefaultSize, loadImageDimensions, PDF_LONGEST_SIDE } from '@/lib/imageLoad'
import { TOOLBAR_PRESS_DURATION } from '@/lib/motion'
import { createSticky, createText } from '@/lib/objectFactory'
import { screenToWorld } from '@/lib/transform'
import { useCanvasStore } from '@/store/canvas'
import { nanoid } from 'nanoid'

export function Toolbar() {
  const fileInputRef = useRef<HTMLInputElement>(null)
  const pdfInputRef = useRef<HTMLInputElement>(null)
  const addObject = useCanvasStore((s) => s.addObject)
  const clearBoard = useCanvasStore((s) => s.clearBoard)
  const commit = useCanvasStore((s) => s.commitBeforeAction)
  const objectsCount = useCanvasStore((s) => s.objects.length)

  const viewCenterWorld = () => {
    const { scale, offset, viewportSize } = useCanvasStore.getState()
    return screenToWorld(
      { x: viewportSize.width / 2, y: viewportSize.height / 2 },
      { scale, x: offset.x, y: offset.y },
    )
  }

  const handleAddSticky = () => {
    commit()
    addObject(createSticky(viewCenterWorld(), objectsCount))
  }

  const handleAddText = () => {
    commit()
    addObject(createText(viewCenterWorld(), objectsCount))
  }

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file || !file.type.startsWith('image/')) return
    const upload = await uploadFile(file)
    const dims = await loadImageDimensions(upload.url)
    const sized = fitToDefaultSize(dims)
    const center = viewCenterWorld()
    commit()
    addObject({
      id: nanoid(),
      type: 'image',
      position: {
        x: center.x - sized.width / 2,
        y: center.y - sized.height / 2,
      },
      size: sized,
      rotation: 0,
      zIndex: objectsCount,
      data: { url: upload.url },
    })
  }

  const handlePdfChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file || file.type !== 'application/pdf') return
    const upload = await uploadFile(file, file.name)
    const center = viewCenterWorld()
    let sized = { width: 180, height: 240 }
    if (upload.thumbnailUrl) {
      const dims = await loadImageDimensions(upload.thumbnailUrl)
      sized = fitToDefaultSize(dims, PDF_LONGEST_SIDE)
    }
    const data: PDFData = {
      url: upload.url,
      thumbnailUrl: upload.thumbnailUrl ?? '',
      extractedText: upload.extractedText ?? '',
      pageCount: upload.pageCount,
    }
    commit()
    addObject({
      id: nanoid(),
      type: 'pdf',
      position: {
        x: center.x - sized.width / 2,
        y: center.y - sized.height / 2,
      },
      size: sized,
      rotation: 0,
      zIndex: objectsCount,
      data,
    })
  }

  return (
    <div
      className="fixed top-4 left-1/2 -translate-x-1/2 z-20 flex items-center gap-0.5 bg-card/95 backdrop-blur-md p-1 shadow-[0_8px_32px_-12px_rgba(0,0,0,0.6)]"
      style={{ borderRadius: 'var(--radius-lg)' }}
    >
      <input
        ref={fileInputRef}
        type="file"
        accept="image/jpeg,image/png,image/webp,image/gif"
        className="hidden"
        onChange={handleFileChange}
      />
      <input
        ref={pdfInputRef}
        type="file"
        accept="application/pdf"
        className="hidden"
        onChange={handlePdfChange}
      />
      <ToolbarButton icon={ImageIcon} label="Image" onClick={() => fileInputRef.current?.click()} />
      <ToolbarButton icon={FilePdf} label="PDF" onClick={() => pdfInputRef.current?.click()} />
      <ToolbarButton icon={NoteBlank} label="Sticky" onClick={handleAddSticky} />
      <ToolbarButton icon={TextT} label="Text" onClick={handleAddText} />
      <div className="mx-1 h-5 w-px bg-[var(--border-soft)]" />
      <ToolbarButton
        icon={Trash}
        label="Clear"
        onlyIcon
        onClick={() => {
          if (objectsCount > 0 && confirm('Clear the board?')) {
            commit()
            clearBoard()
          }
        }}
        muted
        disabled={objectsCount === 0}
      />
    </div>
  )
}

function ToolbarButton({
  onClick,
  label,
  icon: IconCmp,
  muted,
  disabled,
  onlyIcon,
}: {
  onClick: () => void
  label: string
  icon: Icon
  muted?: boolean
  disabled?: boolean
  onlyIcon?: boolean
}) {
  return (
    <motion.button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={label}
      aria-label={label}
      whileTap={disabled ? undefined : { scale: 0.94 }}
      transition={{ duration: TOOLBAR_PRESS_DURATION, ease: [0.3, 0, 0.2, 1] }}
      className={`inline-flex items-center gap-1.5 ${
        onlyIcon ? 'px-2' : 'pl-2 pr-2.5'
      } py-1.5 text-sm font-medium transition-colors ${
        muted ? 'text-muted-foreground hover:text-foreground' : 'text-foreground'
      } hover:bg-[var(--bg-elevated)] disabled:opacity-40 disabled:hover:bg-transparent`}
      style={{ borderRadius: 'var(--radius)' }}
    >
      <IconCmp size={16} weight="regular" />
      {!onlyIcon && <span>{label}</span>}
    </motion.button>
  )
}
