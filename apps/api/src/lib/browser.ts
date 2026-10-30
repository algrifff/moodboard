import { existsSync } from 'node:fs'
import { chromium, type Browser } from 'playwright'

// One headless Chromium per API process, shared by the share-PDF renderer
// and the output frame renderer. Cold launch costs ~1.5s; reusing it trims
// each render to a new context. CHROMIUM_PATH points at a specific build
// (a container's own headless shell); otherwise Playwright's own build.

let browserPromise: Promise<Browser> | null = null

export function chromiumExecutablePath(): string | undefined {
  return process.env.CHROMIUM_PATH || undefined
}

export function getBrowser(): Promise<Browser> {
  if (!browserPromise) {
    const launching = chromium
      .launch({
        executablePath: chromiumExecutablePath(),
        // --no-sandbox is required on Railway / most container hosts where
        // user namespaces aren't available. What we render is our own share
        // page or a composed output whose CSP forbids all network access.
        args: ['--no-sandbox', '--disable-dev-shm-usage'],
        headless: true,
      })
      .then((browser) => {
        // A crashed browser must not be handed out again.
        browser.on('disconnected', () => {
          if (browserPromise === launching) browserPromise = null
        })
        return browser
      })
      .catch((e) => {
        // Reset so the next call retries the launch rather than
        // permanently failing with the same rejected promise.
        browserPromise = null
        throw e
      })
    browserPromise = launching
  }
  return browserPromise
}

export async function closeBrowser(): Promise<void> {
  const pending = browserPromise
  browserPromise = null
  if (!pending) return
  const browser = await pending.catch(() => null)
  await browser?.close().catch(() => undefined)
}

// Whether a browser binary is installed (tests skip their render cases
// where there is none).
export function chromiumAvailable(): boolean {
  try {
    return existsSync(chromiumExecutablePath() ?? chromium.executablePath())
  } catch {
    return false
  }
}
