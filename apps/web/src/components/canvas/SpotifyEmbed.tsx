// Spotify embed player. The iframe widget plays a 30s preview for anyone
// and the full track if the user has Spotify open/logged in — independent
// of the (deprecated) preview_url API field. `compact` (80px) is used on
// the canvas card; the taller 152px variant is used in the detail modal.
//
// Shared by SpotifyNode (inline, on-canvas playback) and SpotifyDetailModal.

export function SpotifyEmbed({
  type,
  id,
  compact,
}: {
  type: 'track' | 'playlist' | 'album'
  id: string
  compact?: boolean
}) {
  const height = compact ? 80 : 152
  return (
    <iframe
      title="Spotify player"
      src={`https://open.spotify.com/embed/${type}/${id}?theme=0`}
      width="100%"
      height={height}
      allow="autoplay; clipboard-write; encrypted-media; fullscreen; picture-in-picture"
      loading="lazy"
      style={{ border: 'none', borderRadius: 12, display: 'block', colorScheme: 'normal' }}
    />
  )
}
