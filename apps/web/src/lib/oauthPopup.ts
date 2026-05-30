// Open a centred OAuth popup and wait for the server's callback page to
// postMessage a result back.
//
// Three things make this safe-ish:
//   1. The popup is opened at the FRONTEND origin (not the API origin),
//      so the better-auth session cookie travels with it. We rely on the
//      Vite proxy (in dev) / same-origin deploy (in prod) to forward
//      /api/connections/{provider}/start to the backend. The Notion
//      redirect URI is also pinned to the frontend origin, so the state
//      cookie set on /start is sent back to /callback.
//   2. The postMessage handler here only accepts messages where
//      e.origin === window.location.origin.
//   3. We poll `popup.closed` so a user who dismisses the popup gets a
//      crisp "Cancelled" rejection instead of a hanging promise.

type PopupResult = { id: string }

export async function openConnectionPopup(provider: 'notion' | 'drive'): Promise<PopupResult> {
  // Open at the current origin — the server side handles the OAuth dance
  // and we receive a postMessage back from the callback page once it
  // finishes. Using a relative URL means the session cookie comes along.
  const url = `/api/connections/${provider}/start`
  const expectedOrigin = window.location.origin
  const w = 480
  const h = 640
  const left = Math.max(0, Math.floor((window.screen.availWidth - w) / 2))
  const top = Math.max(0, Math.floor((window.screen.availHeight - h) / 2))
  const popup = window.open(
    url,
    'mb_oauth',
    `width=${w},height=${h},left=${left},top=${top},popup=yes,noopener=no`,
  )
  if (!popup) {
    throw new Error('Pop-up blocked. Allow pop-ups for this site and try again.')
  }

  return await new Promise<PopupResult>((resolve, reject) => {
    let settled = false
    const settle = (fn: () => void) => {
      if (settled) return
      settled = true
      window.removeEventListener('message', onMessage)
      clearInterval(closedPoll)
      fn()
    }

    const onMessage = (e: MessageEvent) => {
      // Strict origin check — only the same origin (the popup callback
      // page, served via the proxy) can deliver a result.
      if (e.origin !== expectedOrigin) return
      const data = e.data as { type?: unknown; id?: unknown; message?: unknown } | null
      if (!data || typeof data !== 'object') return
      if (data.type === 'mb:connection:done' && typeof data.id === 'string') {
        settle(() => resolve({ id: data.id as string }))
      } else if (data.type === 'mb:connection:error') {
        const msg = typeof data.message === 'string' ? data.message : 'Connection failed'
        settle(() => reject(new Error(msg)))
      }
    }
    window.addEventListener('message', onMessage)

    // Polling fallback — if the user closes the popup without finishing, we
    // need to reject so the UI can stop waiting.
    const closedPoll = setInterval(() => {
      if (popup.closed) settle(() => reject(new Error('Cancelled')))
    }, 500)
  })
}
