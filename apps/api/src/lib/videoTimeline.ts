import { VIDEO_READY_MESSAGE, VIDEO_SEEK_MESSAGE } from '@moodboard/shared'

// Composed into every video document (after the template's own script, so
// WAAPI animations it starts are already there). It takes hold of the
// document's animations when it runs, but leaves them playing: a downloaded
// file just plays. Only a seek pauses them and sets their time — from the
// frame renderer (window.__moodboardTimeline.seek) or, in the output view's
// sandboxed preview, from the parent's postMessage. The renderer and the
// preview therefore show exactly the same frame for the same time.
export const TIMELINE_SCRIPT = `(() => {
  const root = document.querySelector('[data-duration]')
  const duration = root ? Number(root.getAttribute('data-duration')) : 0
  const animations = document.getAnimations()
  const timeline = {
    duration,
    animations: animations.length,
    seek(time) {
      for (const a of animations) {
        a.pause()
        a.currentTime = time
      }
    },
  }
  window.__moodboardTimeline = timeline
  window.addEventListener('message', (e) => {
    const msg = e.data
    if (e.source === window.parent && msg && msg.type === ${JSON.stringify(VIDEO_SEEK_MESSAGE)} && typeof msg.time === 'number') {
      timeline.seek(msg.time)
    }
  })
  if (window.parent !== window) window.parent.postMessage({ type: ${JSON.stringify(VIDEO_READY_MESSAGE)}, duration }, '*')
})()`
