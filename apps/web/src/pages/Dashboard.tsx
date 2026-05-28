import type { BoardSummary } from '@moodboard/shared'
import { Plus, SignOut, Trash } from '@phosphor-icons/react'
import { useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useSession, signOut } from '@/lib/authClient'
import { createBoard, deleteBoard, listBoards } from '@/lib/boardsApi'

function formatWhen(iso: string): string {
  const date = new Date(iso)
  const diff = Date.now() - date.getTime()
  const min = Math.round(diff / 60_000)
  if (min < 1) return 'just now'
  if (min < 60) return `${min}m ago`
  const hr = Math.round(min / 60)
  if (hr < 24) return `${hr}h ago`
  const day = Math.round(hr / 24)
  if (day < 7) return `${day}d ago`
  return date.toLocaleDateString()
}

export function DashboardPage() {
  const { data: session } = useSession()
  const navigate = useNavigate()
  const [boards, setBoards] = useState<BoardSummary[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)

  useEffect(() => {
    let cancelled = false
    listBoards()
      .then((b) => {
        if (!cancelled) setBoards(b)
      })
      .catch((e: Error) => {
        if (!cancelled) setError(e.message)
      })
    return () => {
      cancelled = true
    }
  }, [])

  const handleCreate = async () => {
    setCreating(true)
    try {
      const board = await createBoard()
      navigate(`/board/${board.id}`)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setCreating(false)
    }
  }

  const handleDelete = async (id: string) => {
    if (!confirm('Delete this board? This cannot be undone.')) return
    await deleteBoard(id)
    setBoards((b) => (b ? b.filter((x) => x.id !== id) : b))
  }

  const handleSignOut = async () => {
    await signOut()
    navigate('/sign-in')
  }

  return (
    <div className="min-h-screen bg-background">
      <header>
        <div className="max-w-5xl mx-auto px-6 py-5 flex items-center justify-between">
          <h1 className="text-base font-semibold tracking-tight text-foreground">moodboard.ai</h1>
          <div className="flex items-center gap-5 text-sm">
            <span className="text-muted-foreground">{session?.user?.email}</span>
            <button
              type="button"
              onClick={handleSignOut}
              className="inline-flex items-center gap-1.5 text-muted-foreground hover:text-foreground transition-colors"
              aria-label="Sign out"
            >
              <SignOut size={14} weight="regular" />
              Sign out
            </button>
          </div>
        </div>
      </header>

      <main className="max-w-5xl mx-auto px-6 pt-6 pb-16">
        <div className="flex items-end justify-between mb-8">
          <div>
            <h2 className="text-2xl font-semibold tracking-tight text-foreground">Your boards</h2>
            <p className="mt-1.5 text-sm text-muted-foreground">
              Drop, group, and let the read come to you.
            </p>
          </div>
          <button
            type="button"
            onClick={handleCreate}
            disabled={creating}
            className="inline-flex items-center gap-1.5 bg-primary text-primary-foreground pl-3 pr-3.5 py-2 text-sm font-medium hover:brightness-110 disabled:opacity-50 transition-[filter,opacity]"
            style={{ borderRadius: 'var(--radius)' }}
          >
            <Plus size={14} weight="bold" />
            {creating ? 'Creating…' : 'New board'}
          </button>
        </div>

        {error && <p className="text-sm text-destructive mb-4">Error: {error}</p>}
        {boards === null && !error && <DashboardSkeleton />}
        {boards && boards.length === 0 && (
          <div
            className="bg-card py-16 px-6 text-center"
            style={{ borderRadius: 'var(--radius-lg)' }}
          >
            <h3 className="text-lg font-semibold text-foreground">No boards yet</h3>
            <p className="mt-2 text-sm text-muted-foreground max-w-sm mx-auto">
              Start a board to drop in images, sticky notes, and PDFs. Group them on the canvas and
              see what Claude sees.
            </p>
            <button
              type="button"
              onClick={handleCreate}
              className="inline-flex items-center gap-1.5 mt-6 bg-primary text-primary-foreground pl-3 pr-3.5 py-2 text-sm font-medium hover:brightness-110 transition-[filter]"
              style={{ borderRadius: 'var(--radius)' }}
            >
              <Plus size={14} weight="bold" />
              Create your first board
            </button>
          </div>
        )}

        {boards && boards.length > 0 && (
          <ul className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {boards.map((b) => (
              <li key={b.id} className="group relative">
                <Link
                  to={`/board/${b.id}`}
                  className="block bg-card p-4 hover:bg-[var(--bg-elevated)] transition-colors"
                  style={{ borderRadius: 'var(--radius-lg)' }}
                >
                  <div
                    className="aspect-[4/3] mb-3 bg-[var(--bg-muted)]"
                    style={{ borderRadius: 'var(--radius)' }}
                  />
                  <p className="text-sm font-medium text-foreground truncate">{b.name}</p>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    Edited {formatWhen(b.updatedAt)}
                  </p>
                </Link>
                <button
                  type="button"
                  onClick={() => handleDelete(b.id)}
                  className="absolute top-3 right-3 opacity-0 group-hover:opacity-100 p-1.5 text-muted-foreground hover:text-destructive hover:bg-[var(--bg-elevated)] transition-[opacity,color,background-color]"
                  style={{ borderRadius: 'var(--radius)' }}
                  aria-label="Delete board"
                  title="Delete board"
                >
                  <Trash size={14} weight="regular" />
                </button>
              </li>
            ))}
          </ul>
        )}
      </main>
    </div>
  )
}

function DashboardSkeleton() {
  // Three placeholder tiles matching the real card layout. Pulse subtly so
  // the page doesn't read as broken while the list is in flight.
  return (
    <ul className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
      {[0, 1, 2].map((i) => (
        <li
          key={i}
          className="bg-card p-4 animate-pulse"
          aria-hidden
          style={{ borderRadius: 'var(--radius-lg)' }}
        >
          <div
            className="aspect-[4/3] mb-3 bg-[var(--bg-muted)]"
            style={{ borderRadius: 'var(--radius)' }}
          />
          <div
            className="h-3.5 w-2/3 bg-[var(--bg-muted)]"
            style={{ borderRadius: 'var(--radius)' }}
          />
          <div
            className="mt-2 h-3 w-1/3 bg-[var(--bg-muted)]"
            style={{ borderRadius: 'var(--radius)' }}
          />
        </li>
      ))}
    </ul>
  )
}
