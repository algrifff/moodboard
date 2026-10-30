// Keyboard navigation between slides. Scroll-snap does the snapping; this
// only picks the target. Ignored while a slot is being edited in place.
;(() => {
  const slides = () => Array.from(document.querySelectorAll('.slide'))
  const current = () => {
    let best = 0
    let distance = Infinity
    slides().forEach((slide, i) => {
      const d = Math.abs(slide.getBoundingClientRect().top)
      if (d < distance) {
        distance = d
        best = i
      }
    })
    return best
  }
  const go = (index) => {
    const list = slides()
    const target = list[Math.max(0, Math.min(list.length - 1, index))]
    if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }
  const NEXT = ['ArrowRight', 'ArrowDown', 'PageDown', ' ']
  const PREV = ['ArrowLeft', 'ArrowUp', 'PageUp']
  document.addEventListener('keydown', (e) => {
    if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey) return
    if (e.target instanceof HTMLElement && e.target.isContentEditable) return
    let index = null
    if (NEXT.includes(e.key)) index = current() + (e.shiftKey && e.key === ' ' ? -1 : 1)
    else if (PREV.includes(e.key)) index = current() - 1
    else if (e.key === 'Home') index = 0
    else if (e.key === 'End') index = slides().length - 1
    if (index === null) return
    e.preventDefault()
    go(index)
  })
})()
