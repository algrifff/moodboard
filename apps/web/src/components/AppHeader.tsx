import { SignOut } from '@phosphor-icons/react'
import { Link, NavLink, useNavigate } from 'react-router-dom'
import { signOut, useSession } from '@/lib/authClient'

const NAV = [
  { to: '/', label: 'Boards', end: true },
  { to: '/outputs', label: 'Outputs', end: false },
  { to: '/kits', label: 'Kits', end: false },
  { to: '/library', label: 'Library', end: false },
]

// Top bar for the pages outside the canvas: boards, kits and the asset
// library, with the account links on the right.
export function AppHeader({ wide }: { wide?: boolean }) {
  const { data: session } = useSession()
  const navigate = useNavigate()

  return (
    <header>
      <div
        className={`mx-auto flex ${wide ? 'max-w-6xl' : 'max-w-5xl'} items-center justify-between gap-6 px-6 py-5`}
      >
        <div className="flex items-center gap-8">
          <h1 className="text-base font-semibold tracking-tight text-foreground">moodboard.ai</h1>
          <nav className="flex items-center gap-1" aria-label="Sections">
            {NAV.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                end={item.end}
                className={({ isActive }) =>
                  `rounded-lg px-2.5 py-1 text-sm transition-colors ${
                    isActive
                      ? 'bg-[var(--bg-elevated)] text-foreground'
                      : 'text-muted-foreground hover:text-foreground'
                  }`
                }
              >
                {item.label}
              </NavLink>
            ))}
          </nav>
        </div>
        <div className="flex items-center gap-5 text-sm">
          <Link
            to="/settings"
            className="text-muted-foreground transition-colors hover:text-foreground"
            title="Settings"
          >
            {session?.user?.email}
          </Link>
          <button
            type="button"
            onClick={async () => {
              await signOut()
              navigate('/sign-in')
            }}
            className="inline-flex items-center gap-1.5 text-muted-foreground transition-colors hover:text-foreground"
            aria-label="Sign out"
          >
            <SignOut size={14} weight="regular" />
            Sign out
          </button>
        </div>
      </div>
    </header>
  )
}
