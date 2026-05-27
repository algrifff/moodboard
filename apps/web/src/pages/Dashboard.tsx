import type { BoardSummary } from '@moodboard/shared'
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
    <div className="min-h-screen bg-slate-50">
      <header className="border-b bg-white">
        <div className="max-w-5xl mx-auto px-6 py-4 flex items-center justify-between">
          <h1 className="text-lg font-semibold">moodboard.ai</h1>
          <div className="flex items-center gap-4 text-sm">
            <span className="text-muted-foreground">{session?.user?.email}</span>
            <button
              type="button"
              onClick={handleSignOut}
              className="text-slate-600 hover:text-slate-900"
            >
              Sign out
            </button>
          </div>
        </div>
      </header>

      <main className="max-w-5xl mx-auto px-6 py-8">
        <div className="flex items-center justify-between mb-6">
          <h2 className="text-xl font-semibold">Your boards</h2>
          <button
            type="button"
            onClick={handleCreate}
            disabled={creating}
            className="rounded-md bg-slate-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-50"
          >
            {creating ? 'Creating…' : '+ New board'}
          </button>
        </div>

        {error && <p className="text-sm text-red-600 mb-4">Error: {error}</p>}
        {boards === null && !error && (
          <p className="text-sm text-muted-foreground">Loading…</p>
        )}
        {boards && boards.length === 0 && (
          <div className="rounded-lg border-2 border-dashed border-slate-300 bg-white py-12 text-center">
            <p className="text-sm text-muted-foreground">No boards yet.</p>
            <button
              type="button"
              onClick={handleCreate}
              className="mt-3 rounded-md bg-slate-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-slate-800"
            >
              Create your first board
            </button>
          </div>
        )}

        {boards && boards.length > 0 && (
          <ul className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {boards.map((b) => (
              <li key={b.id} className="group relative">
                <Link
                  to={`/board/${b.id}`}
                  className="block rounded-lg border bg-white p-4 hover:border-slate-400 hover:shadow-sm transition"
                >
                  <div className="aspect-[4/3] mb-3 rounded bg-slate-100" />
                  <p className="text-sm font-medium text-slate-900 truncate">{b.name}</p>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    Edited {formatWhen(b.updatedAt)}
                  </p>
                </Link>
                <button
                  type="button"
                  onClick={() => handleDelete(b.id)}
                  className="absolute top-2 right-2 opacity-0 group-hover:opacity-100 rounded px-2 py-1 text-xs text-red-600 hover:bg-red-50 transition"
                  aria-label="Delete board"
                >
                  Delete
                </button>
              </li>
            ))}
          </ul>
        )}
      </main>
    </div>
  )
}
