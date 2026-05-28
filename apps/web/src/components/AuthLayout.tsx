export function AuthLayout({
  title,
  subtitle,
  children,
}: {
  title: string
  subtitle: string
  children: React.ReactNode
}) {
  return (
    <div className="min-h-screen flex items-center justify-center bg-background p-8">
      <div className="w-full max-w-sm space-y-6">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-foreground">{title}</h1>
          <p className="mt-1.5 text-sm text-muted-foreground">{subtitle}</p>
        </div>
        {children}
      </div>
    </div>
  )
}

export function AuthInput({
  ref,
  ...props
}: React.InputHTMLAttributes<HTMLInputElement> & {
  ref?: React.Ref<HTMLInputElement>
}) {
  return (
    <input
      ref={ref}
      {...props}
      className={`w-full bg-[var(--bg-card)] px-3 py-2 text-sm text-foreground placeholder:text-[var(--text-faint)] outline-none ring-1 ring-[var(--border-soft)] focus:ring-[var(--accent)] transition-[box-shadow,background-color] ${
        props.className ?? ''
      }`}
      style={{ borderRadius: 'var(--radius)', ...(props.style ?? {}) }}
    />
  )
}

export function AuthButton(props: React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type="submit"
      {...props}
      className={`w-full bg-primary text-primary-foreground px-3 py-2 text-sm font-medium hover:brightness-110 disabled:opacity-50 transition-[filter,opacity] ${
        props.className ?? ''
      }`}
      style={{ borderRadius: 'var(--radius)', ...(props.style ?? {}) }}
    />
  )
}
