// Video URL recogniser. Detects pasted links to the platforms yt-dlp can
// extract for us, and returns a normalised `{ platform, url }` so the paste
// dispatcher can route to the video importer. The server (yt-dlp) does the
// real resolution — this just decides "is this a video link, and which
// platform?" and must run BEFORE the generic web-URL fallback (which would
// otherwise swallow these, since they're all https://…).
//
// Recognised shapes:
//   youtube.com/watch?v=…, youtu.be/…, youtube.com/shorts/…, music.youtube.com
//   tiktok.com/@user/video/…, vm.tiktok.com/…, tiktok.com/t/…
//   instagram.com/reel/…, instagram.com/p/…, instagram.com/tv/…
//   x.com/user/status/…, twitter.com/user/status/…
//   vimeo.com/{id}

export type VideoRef = {
  platform: 'youtube' | 'tiktok' | 'instagram' | 'x' | 'vimeo'
  url: string
}

function hostMatches(host: string, base: string): boolean {
  return host === base || host.endsWith(`.${base}`)
}

/**
 * Pull a video ref (platform + url) from a pasted URL. Returns null when the
 * input isn't a recognised video link.
 */
export function extractVideoRef(input: string): VideoRef | null {
  const trimmed = input.trim()
  if (!trimmed) return null
  let url: URL
  try {
    url = new URL(trimmed)
  } catch {
    return null
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
  const host = url.hostname.toLowerCase().replace(/^www\./, '')
  const path = url.pathname

  // YouTube — watch / shorts / youtu.be short links / music.
  if (hostMatches(host, 'youtube.com') || host === 'music.youtube.com') {
    const isWatch = path === '/watch' && url.searchParams.has('v')
    const isShort = /^\/shorts\/[\w-]+/.test(path)
    const isEmbed = /^\/embed\/[\w-]+/.test(path)
    const isLive = /^\/live\/[\w-]+/.test(path)
    if (isWatch || isShort || isEmbed || isLive) return { platform: 'youtube', url: trimmed }
    return null
  }
  if (host === 'youtu.be') {
    if (path.length > 1) return { platform: 'youtube', url: trimmed }
    return null
  }

  // TikTok — full @user/video links, short vm. links, and /t/ share links.
  if (hostMatches(host, 'tiktok.com')) {
    if (/\/video\/\d+/.test(path) || /^\/t\//.test(path) || host.startsWith('vm.')) {
      return { platform: 'tiktok', url: trimmed }
    }
    // A bare /@user profile isn't a clip.
    return null
  }

  // Instagram — reels, posts, IGTV.
  if (hostMatches(host, 'instagram.com')) {
    if (/^\/(reel|reels|p|tv)\/[\w-]+/.test(path)) return { platform: 'instagram', url: trimmed }
    return null
  }

  // X / Twitter — status links (the tweet may or may not have video; yt-dlp
  // returns nothing extractable for text-only tweets and the import surfaces
  // a clean error, which is acceptable).
  if (hostMatches(host, 'x.com') || hostMatches(host, 'twitter.com')) {
    if (/\/status\/\d+/.test(path)) return { platform: 'x', url: trimmed }
    return null
  }

  // Vimeo — numeric id paths.
  if (hostMatches(host, 'vimeo.com')) {
    if (/^\/\d+/.test(path)) return { platform: 'vimeo', url: trimmed }
    return null
  }

  return null
}
