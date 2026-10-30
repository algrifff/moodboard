import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// Optional local HTTPS via mkcert. Several OAuth providers require HTTPS
// for redirect URIs (Google for production-ish apps,
// Spotify accepts https://127.0.0.1). When the cert files exist we
// default to HTTPS so the OAuth flows just work; set MOODBOARD_HTTPS=0
// to force plain HTTP if you need it for some reason. Anyone without
// the cert files falls through to HTTP automatically — no setup needed
// to run the dev server.
//
// Generate the certs with:
//   brew install mkcert && mkcert -install
//   mkdir -p apps/web/.certs && cd apps/web/.certs
//   mkcert -cert-file localhost.pem -key-file localhost-key.pem localhost 127.0.0.1 ::1
const HTTPS_OPT_OUT = process.env.MOODBOARD_HTTPS === '0'
const CERT_PATH = path.resolve(__dirname, '.certs/localhost.pem')
const KEY_PATH = path.resolve(__dirname, '.certs/localhost-key.pem')
const HAS_LOCAL_CERT = existsSync(CERT_PATH) && existsSync(KEY_PATH)
const httpsConfig =
  !HTTPS_OPT_OUT && HAS_LOCAL_CERT
    ? { cert: readFileSync(CERT_PATH), key: readFileSync(KEY_PATH) }
    : undefined

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    port: 5173,
    // Bind to both IPv4 (`127.0.0.1`) and IPv6 (`::1`) loopback interfaces
    // — Vite's default `localhost` host on macOS resolves IPv6-first, so
    // an IPv4 hit like `http://127.0.0.1:5173` would otherwise see
    // ERR_CONNECTION_REFUSED. Spotify's OAuth redirect uses 127.0.0.1
    // specifically (it's the only http loopback they accept), so we
    // listen everywhere on the loopback.
    host: true,
    ...(httpsConfig ? { https: httpsConfig } : {}),
    proxy: {
      '/api': {
        target: 'http://localhost:3001',
        changeOrigin: true,
      },
    },
  },
})
