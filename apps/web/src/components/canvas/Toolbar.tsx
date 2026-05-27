import { useRef } from 'react'
import { uploadFile } from '@/lib/api'
import { fitToDefaultSize, loadImageDimensions } from '@/lib/imageLoad'
import { createSticky, createText } from '@/lib/objectFactory'
import { screenToWorld } from '@/lib/transform'
import { useCanvasStore } from '@/store/canvas'
import { nanoid } from 'nanoid'

export function Toolbar() {
  const fileInputRef = useRef<HTMLInputElement>(null)
  const addObject = useCanvasStore((s) => s.addObject)
  const clearBoard = useCanvasStore((s) => s.clearBoard)
  const objectsCount = useCanvasStore((s) => s.objects.length)

  const viewCenterWorld = () => {
    const { scale, offset, viewportSize } = useCanvasStore.getState()
    return screenToWorld(
      { x: viewportSize.width / 2, y: viewportSize.height / 2 },
      { scale, x: offset.x, y: offset.y },
    )
  }

  const handleAddSticky = () => {
    addObject(createSticky(viewCenterWorld(), objectsCount))
  }

  const handleAddText = () => {
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

  return (
    <div className="fixed top-4 left-1/2 -translate-x-1/2 z-20 flex items-center gap-1 rounded-xl border bg-white/95 backdrop-blur-sm shadow-lg p-1">
      <input
        ref={fileInputRef}
        type="file"
        accept="image/jpeg,image/png,image/webp,image/gif"
        className="hidden"
        onChange={handleFileChange}
      />
      <ToolbarButton onClick={() => fileInputRef.current?.click()} label="+ Image" />
      <ToolbarButton onClick={handleAddSticky} label="+ Sticky" />
      <ToolbarButton onClick={handleAddText} label="+ Text" />
      <div className="mx-1 h-5 w-px bg-slate-200" />
      <ToolbarButton
        onClick={() => {
          if (objectsCount > 0 && confirm('Clear the board?')) clearBoard()
        }}
        label="Clear"
        muted
        disabled={objectsCount === 0}
      />
    </div>
  )
}

function ToolbarButton({
  onClick,
  label,
  muted,
  disabled,
}: {
  onClick: () => void
  label: string
  muted?: boolean
  disabled?: boolean
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`px-3 py-1.5 text-sm font-medium rounded-lg transition-colors ${
        muted ? 'text-slate-500' : 'text-slate-900'
      } hover:bg-slate-100 disabled:opacity-40 disabled:hover:bg-transparent`}
    >
      {label}
    </button>
  )
}
