import { useEffect, useRef, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { AuthButton, AuthInput, AuthLayout } from '@/components/AuthLayout'
import { signIn } from '@/lib/authClient'

const STORED_EMAIL_KEY = 'moodboard:lastSignInEmail'

function readStoredEmail(): string {
  if (typeof window === 'undefined') return ''
  try {
    return localStorage.getItem(STORED_EMAIL_KEY) ?? ''
  } catch {
    return ''
  }
}

export function SignInPage() {
  const navigate = useNavigate()
  const [email, setEmail] = useState(readStoredEmail)
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const passwordRef = useRef<HTMLInputElement>(null)

  // If the email is pre-filled (returning user), jump straight to the
  // password field. Cuts the iframe-reload friction roughly in half.
  useEffect(() => {
    if (email.length > 0) passwordRef.current?.focus()
  }, [email])

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      const result = await signIn.email({ email, password })
      if (result?.error) {
        console.warn('sign-in error', result.error)
        setError(result.error.message || result.error.statusText || 'Incorrect email or password.')
        return
      }
      if (!result?.data) {
        setError('Sign in failed. Please try again.')
        return
      }
      try {
        localStorage.setItem(STORED_EMAIL_KEY, email)
      } catch {
        // localStorage may be unavailable (private mode); not fatal.
      }
      navigate('/', { replace: true })
    } catch (e) {
      console.warn('sign-in threw', e)
      setError(e instanceof Error ? e.message : 'Sign in failed.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <AuthLayout title="Welcome back" subtitle="Sign in to moodboard.ai">
      <form onSubmit={onSubmit} className="space-y-3">
        <AuthInput
          type="email"
          placeholder="you@example.com"
          autoComplete="email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
        <AuthInput
          ref={passwordRef}
          type="password"
          placeholder="Password"
          autoComplete="current-password"
          required
          minLength={8}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        {error && <p className="text-xs text-destructive">{error}</p>}
        <AuthButton disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</AuthButton>
      </form>
      <p className="text-center text-xs text-muted-foreground">
        Don't have an account?{' '}
        <Link
          to="/sign-up"
          className="font-medium text-foreground underline underline-offset-4 decoration-[var(--border)] hover:decoration-foreground"
        >
          Sign up
        </Link>
      </p>
    </AuthLayout>
  )
}
