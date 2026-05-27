import { Navigate, useLocation } from 'react-router-dom'
import { useSession } from '@/lib/authClient'

export function RequireAuth({ children }: { children: React.ReactNode }) {
  const { data: session, isPending } = useSession()
  const location = useLocation()

  if (isPending) {
    return (
      <div className="fixed inset-0 flex items-center justify-center text-sm text-muted-foreground">
        Loading…
      </div>
    )
  }

  if (!session) {
    return <Navigate to="/sign-in" replace state={{ from: location.pathname }} />
  }

  return <>{children}</>
}
