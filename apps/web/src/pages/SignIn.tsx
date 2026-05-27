import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { AuthButton, AuthInput, AuthLayout } from '@/components/AuthLayout'
import { signIn } from '@/lib/authClient'

export function SignInPage() {
  const navigate = useNavigate()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setError(null)
    const result = await signIn.email({ email, password })
    setBusy(false)
    if (result.error) {
      setError(result.error.message ?? 'Sign in failed')
      return
    }
    navigate('/', { replace: true })
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
          type="password"
          placeholder="Password"
          autoComplete="current-password"
          required
          minLength={8}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        {error && <p className="text-xs text-red-600">{error}</p>}
        <AuthButton disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</AuthButton>
      </form>
      <p className="text-center text-xs text-muted-foreground">
        Don't have an account?{' '}
        <Link to="/sign-up" className="font-medium text-slate-900 underline">
          Sign up
        </Link>
      </p>
    </AuthLayout>
  )
}
