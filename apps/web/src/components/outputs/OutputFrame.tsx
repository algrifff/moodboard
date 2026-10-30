import { viewportSize, type TemplateViewport } from '@moodboard/shared'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'

// A composed output in a sandboxed iframe, scaled to fit its box. The
// document is untrusted (agents write it), so the frame never gets
// allow-same-origin: it runs in an opaque origin and can't reach the app,
// its cookies or the API. The server's CSP already forbids any network and
// only lets the composed-in scripts (template script, inline editor) run,
// so allow-scripts is safe to grant everywhere.
//
// Fixed-size documents are laid out at their design size and scaled down
// (or up) to fit. Responsive ones are laid out at `deviceWidth` and scaled
// to the box's width, filling its height.
//
// Changing `src` keeps the current document on screen until the next one
// has loaded, so switching kits or versions swaps without a blank flash.

type Layer = { key: number; src: string; loaded: boolean }

export function OutputFrame({
  src,
  viewport,
  deviceWidth = 1440,
  interactive = false,
  title,
  onMessage,
  className = '',
  maxScale = 1,
  shadow = true,
}: {
  src: string
  viewport: TemplateViewport
  deviceWidth?: number
  // Pointer + keyboard reach the document (deck navigation, inline edits).
  interactive?: boolean
  title: string
  onMessage?: (data: unknown) => void
  className?: string
  maxScale?: number
  shadow?: boolean
}) {
  const boxRef = useRef<HTMLDivElement>(null)
  const frames = useRef(new Map<number, HTMLIFrameElement>())
  const [box, setBox] = useState({ width: 0, height: 0 })
  const [layers, setLayers] = useState<Layer[]>([{ key: 0, src, loaded: false }])

  useLayoutEffect(() => {
    const el = boxRef.current
    if (!el) return
    const measure = () => {
      const cs = getComputedStyle(el)
      setBox({
        width: el.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight),
        height: el.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom),
      })
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  useEffect(() => {
    setLayers((prev) =>
      prev.at(-1)?.src === src
        ? prev
        : [...prev.filter((l) => l.loaded).slice(-1), { key: Date.now(), src, loaded: false }],
    )
  }, [src])

  useEffect(() => {
    if (!onMessage) return
    const listener = (e: MessageEvent) => {
      // Only our own frames; their origin is opaque ("null"), so the
      // window reference is the identity check.
      const ours = [...frames.current.values()].some((f) => f.contentWindow === e.source)
      if (ours) onMessage(e.data)
    }
    window.addEventListener('message', listener)
    return () => window.removeEventListener('message', listener)
  }, [onMessage])

  const natural =
    viewport.kind === 'fixed' ? viewportSize(viewport) : { width: deviceWidth, height: 0 }
  const scale =
    box.width === 0
      ? 0
      : viewport.kind === 'fixed'
        ? Math.min(box.width / natural.width, box.height / natural.height, maxScale)
        : Math.min(box.width / natural.width, maxScale)
  const height = viewport.kind === 'fixed' ? natural.height : scale > 0 ? box.height / scale : 0

  return (
    <div ref={boxRef} className={`relative flex items-center justify-center ${className}`}>
      {scale > 0 && (
        <div
          className="relative shrink-0 overflow-hidden"
          style={{
            width: natural.width * scale,
            height: height * scale,
            boxShadow: shadow ? 'var(--shadow-card)' : undefined,
            backgroundColor: 'var(--bg-elevated)',
          }}
        >
          {layers.map((layer, i) => (
            <iframe
              key={layer.key}
              ref={(el) => {
                if (el) frames.current.set(layer.key, el)
                else frames.current.delete(layer.key)
              }}
              title={title}
              src={layer.src}
              sandbox="allow-scripts"
              referrerPolicy="no-referrer"
              tabIndex={interactive ? 0 : -1}
              onLoad={() =>
                setLayers((prev) => {
                  const idx = prev.findIndex((l) => l.key === layer.key)
                  if (idx === -1) return prev
                  return prev
                    .slice(idx)
                    .map((l) => (l.key === layer.key ? { ...l, loaded: true } : l))
                })
              }
              style={{
                position: 'absolute',
                left: 0,
                top: 0,
                width: natural.width,
                height,
                border: 0,
                transform: `scale(${scale})`,
                transformOrigin: '0 0',
                pointerEvents: interactive ? 'auto' : 'none',
                opacity: layer.loaded || i === 0 ? 1 : 0,
                backgroundColor: 'transparent',
              }}
            />
          ))}
        </div>
      )}
    </div>
  )
}
