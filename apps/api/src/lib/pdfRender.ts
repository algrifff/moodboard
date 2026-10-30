import { getBrowser } from './browser'

// 30s ceiling — the viewer rarely takes more than 5s in practice (Konva
// hydrate + image loads) but a slow network image shouldn't hang the
// render forever.
const PAGE_LOAD_TIMEOUT_MS = 30_000
const READY_FLAG_TIMEOUT_MS = 30_000

export async function renderSharePdf(token: string, baseUrl: string): Promise<Buffer> {
  const browser = await getBrowser()
  const context = await browser.newContext({
    // Wide viewport so Konva fits the canvas to a high-res hero before
    // we ask for a PDF. The PDF format itself is A4 — the viewport size
    // doesn't constrain page size, only initial layout.
    viewport: { width: 1280, height: 1800 },
    deviceScaleFactor: 2,
    // Local dev runs Vite on https with mkcert, whose root CA isn't
    // visible to Playwright's bundled Chromium even though the OS
    // trusts it. The URL we navigate to is one we control
    // (PUBLIC_APP_URL), so accepting whatever cert it presents is safe
    // — there's no untrusted input here.
    ignoreHTTPSErrors: true,
  })
  const page = await context.newPage()
  try {
    const url = `${baseUrl.replace(/\/$/, '')}/share/${encodeURIComponent(token)}?print=1`
    await page.goto(url, { waitUntil: 'networkidle', timeout: PAGE_LOAD_TIMEOUT_MS })
    // The viewer sets window.__SHARE_READY once Konva has hydrated and
    // all <img> elements have loaded. Without this, the PDF can land
    // mid-render with broken images.
    await page.waitForFunction(
      () => (window as unknown as { __SHARE_READY?: boolean }).__SHARE_READY === true,
      undefined,
      { timeout: READY_FLAG_TIMEOUT_MS },
    )
    const pdf = await page.pdf({
      format: 'A4',
      printBackground: true,
      margin: {
        top: '12mm',
        bottom: '14mm',
        left: '12mm',
        right: '12mm',
      },
      // Print CSS in the viewer page controls page breaks between
      // groups (`break-before: page`). preferCSSPageSize lets that win
      // over the format above when set.
      preferCSSPageSize: false,
    })
    return pdf
  } finally {
    await context.close()
  }
}
