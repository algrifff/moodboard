import { Component, type ReactNode } from 'react'

type Props = { children: ReactNode }
type State = { error: Error | null }

// React error boundary at the app root. Catches render-time and lifecycle
// errors in any descendant component and replaces them with a recoverable
// fallback instead of a blank screen. Event-handler errors and async
// rejections aren't caught here — those should still surface via console
// and (once wired) Sentry.
export class ErrorBoundary extends Component<Props, State> {
  override state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  override componentDidCatch(error: Error, info: { componentStack?: string | null }): void {
    // Keep the console log around even after we add real error reporting —
    // local-dev debugging still benefits from it.
    console.error('App-level error caught:', error, info.componentStack)
  }

  private handleReload = (): void => {
    window.location.reload()
  }

  private handleDismiss = (): void => {
    this.setState({ error: null })
  }

  override render(): ReactNode {
    const { error } = this.state
    if (!error) return this.props.children
    return (
      <div className="min-h-screen bg-background flex items-center justify-center px-6">
        <div
          className="max-w-md w-full bg-card p-6 text-center shadow-[0_8px_32px_-12px_rgba(0,0,0,0.6)]"
          style={{ borderRadius: 'var(--radius-lg)' }}
        >
          <h2 className="text-lg font-semibold text-foreground">Something went wrong</h2>
          <p className="mt-2 text-sm text-muted-foreground">
            The page hit an unexpected error. Your work up to the last autosave is safe.
          </p>
          <pre
            className="mt-4 text-xs text-left text-muted-foreground bg-muted p-3 overflow-auto max-h-40"
            style={{ borderRadius: 'var(--radius)' }}
          >
            {error.message}
          </pre>
          <div className="mt-5 flex items-center justify-center gap-2">
            <button
              type="button"
              onClick={this.handleDismiss}
              style={{ borderRadius: 'var(--radius)' }}
              className="px-3 py-1.5 text-sm text-muted-foreground hover:text-foreground hover:bg-[var(--bg-elevated)] transition-colors"
            >
              Try again
            </button>
            <button
              type="button"
              onClick={this.handleReload}
              style={{ borderRadius: 'var(--radius)' }}
              className="bg-primary text-primary-foreground px-3.5 py-1.5 text-sm font-medium hover:brightness-110 transition-[filter]"
            >
              Reload
            </button>
          </div>
        </div>
      </div>
    )
  }
}
