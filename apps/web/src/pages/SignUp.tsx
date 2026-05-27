import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { AuthButton, AuthInput, AuthLayout } from '@/components/AuthLayout'
import { signUp } from '@/lib/authClient'

export function SignUpPage() {
  const navigate = useNavigate()
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setError(null)
    const result = await signUp.email({ name, email, password })
    setBusy(false)
    if (result.error) {
      setError(result.error.message ?? 'Sign up failed')
      return
    }
    navigate('/', { replace: true })
  }

  return (
    <AuthLayout title="Create an account" subtitle="Start a board in seconds.">
      <form onSubmit={onSubmit} className="space-y-3">
        <AuthInput
          type="text"
          placeholder="Your name"
          autoComplete="name"
          required
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
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
          placeholder="Password (8+ characters)"
          autoComplete="new-password"
          required
          minLength={8}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        {error && <p className="text-xs text-red-600">{error}</p>}
        <AuthButton disabled={busy}>{busy ? 'Creating account…' : 'Create account'}</AuthButton>
      </form>
      <p className="text-center text-xs text-muted-foreground">
        Already have an account?{' '}
        <Link to="/sign-in" className="font-medium text-slate-900 underline">
          Sign in
        </Link>
      </p>
    </AuthLayout>
  )
}
