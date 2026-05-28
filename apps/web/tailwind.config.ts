import type { Config } from 'tailwindcss'

const config: Config = {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    container: {
      center: true,
      padding: '2rem',
      screens: { '2xl': '1400px' },
    },
    extend: {
      colors: {
        // Direct OKLCH tokens from index.css. No more hsl(var(...)) — the
        // shadcn boilerplate that gave every demo template its smell.
        border: 'var(--border)',
        'border-soft': 'var(--border-soft)',
        input: 'var(--border)',
        ring: 'var(--accent)',
        background: 'var(--bg)',
        foreground: 'var(--text)',
        primary: {
          DEFAULT: 'var(--text)',
          foreground: 'var(--bg-card)',
        },
        secondary: {
          DEFAULT: 'var(--bg-muted)',
          foreground: 'var(--text)',
        },
        destructive: {
          DEFAULT: 'var(--danger)',
          foreground: 'var(--bg-card)',
        },
        muted: {
          DEFAULT: 'var(--bg-muted)',
          foreground: 'var(--text-mute)',
        },
        accent: {
          DEFAULT: 'var(--accent)',
          foreground: 'var(--bg-card)',
          soft: 'var(--accent-soft)',
        },
        card: {
          DEFAULT: 'var(--bg-card)',
          foreground: 'var(--text)',
        },
        elevated: 'var(--bg-elevated)',
        moodboard: {
          accent: 'var(--accent)',
        },
      },
      fontSize: {
        // Product type scale, tight 1.125 ratio. Replaces ad-hoc
        // text-[10px] / text-[11px] / text-[12.5px] usages.
        micro: ['11px', { lineHeight: '1.4' }],
        xs: ['12px', { lineHeight: '1.45' }],
        sm: ['13px', { lineHeight: '1.5' }],
        base: ['14px', { lineHeight: '1.5' }],
        lg: ['16px', { lineHeight: '1.55' }],
        xl: ['18px', { lineHeight: '1.4' }],
        '2xl': ['22px', { lineHeight: '1.3', letterSpacing: '-0.01em' }],
        '3xl': ['28px', { lineHeight: '1.2', letterSpacing: '-0.02em' }],
      },
      borderRadius: {
        lg: 'var(--radius)',
        md: 'calc(var(--radius) - 2px)',
        sm: 'calc(var(--radius) - 4px)',
      },
    },
  },
  plugins: [],
}

export default config
