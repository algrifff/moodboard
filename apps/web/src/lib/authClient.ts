import { createAuthClient } from 'better-auth/react'

// better-auth's client wants an absolute URL. We use the current origin so the
// Vite proxy forwards /api/auth/* to the api server in dev, and so the same
// build works in prod where web + api share an origin (or are configured to).
const baseURL =
  typeof window !== 'undefined'
    ? `${window.location.origin}/api/auth`
    : 'http://localhost:5173/api/auth'

export const authClient = createAuthClient({ baseURL })

export const { useSession, signIn, signUp, signOut } = authClient
