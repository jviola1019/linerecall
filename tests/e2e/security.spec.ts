import { test, expect } from '@playwright/test'
import { hardenHtml } from '../../scripts/security/lib/csp.ts'
import { APP_PATH, waitForReadyApp } from './helpers.ts'

test('hash-only CSP blocks injected inline code and the loaded app requests no subresources', async ({ page }) => {
  const requests: Array<{ type: string; url: string }> = []
  const consoleMessages: string[] = []
  page.on('request', (request) => requests.push({ type: request.resourceType(), url: request.url() }))
  page.on('console', (message) => consoleMessages.push(message.text()))
  await page.addInitScript(() => {
    ;(window as Window & { __linerecallInjected?: number }).__linerecallInjected = 0
  })
  await page.goto(APP_PATH, { waitUntil: 'domcontentloaded' })
  await waitForReadyApp(page)

  await page.evaluate(() => {
    const script = document.createElement('script')
    script.textContent = 'window.__linerecallInjected = 1'
    document.body.append(script)
  })
  await page.waitForTimeout(100)

  expect(await page.evaluate(() =>
    (window as Window & { __linerecallInjected?: number }).__linerecallInjected
  )).toBe(0)
  expect(consoleMessages.some((message) =>
    /content security policy|script-src|refused to execute inline script/iu.test(message)
  )).toBe(true)
  expect(requests.filter((request) => request.type !== 'document')).toEqual([])
})

test('hash-only CSP executes inline code after browser newline normalization', async ({ page }) => {
  const source = '<!doctype html><html><head></head><body>'
    + '<script>document.documentElement.dataset.cspNewline = "ready";\r\n'
    + 'document.documentElement.dataset.cspSecond = "ready";\r</script>'
    + '</body></html>'
  const hardened = hardenHtml(source)

  await page.goto(`data:text/html;charset=utf-8,${encodeURIComponent(hardened.html)}`)

  await expect(page.locator('html')).toHaveAttribute('data-csp-newline', 'ready')
  await expect(page.locator('html')).toHaveAttribute('data-csp-second', 'ready')
})

test('hosted response delivers the build-bound CSP and complete security/privacy headers', async ({ page }) => {
  const response = await page.request.get(APP_PATH)
  expect(response.ok()).toBe(true)
  await page.goto(APP_PATH, { waitUntil: 'domcontentloaded' })
  await waitForReadyApp(page)
  const headers = response.headers()
  const metaPolicy = await page.locator('meta[http-equiv="Content-Security-Policy"]').getAttribute('content')

  expect(headers['content-security-policy']).toBe(metaPolicy)
  expect(headers['content-security-policy']).toContain("frame-ancestors 'none'")
  expect(headers['content-security-policy']).toContain("connect-src 'none'")
  expect(headers['x-content-type-options']).toBe('nosniff')
  expect(headers['x-frame-options']).toBe('DENY')
  expect(headers['referrer-policy']).toBe('no-referrer')
  expect(headers['strict-transport-security']).toBe('max-age=31536000')
  expect(headers['cross-origin-opener-policy']).toBe('same-origin')
  expect(headers['cross-origin-resource-policy']).toBe('same-origin')
  expect(headers['origin-agent-cluster']).toBe('?1')
  expect(headers['x-permitted-cross-domain-policies']).toBe('none')
  expect(headers['x-xss-protection']).toBe('0')
  expect(headers['cache-control']).toBe('no-store, max-age=0, must-revalidate')
  expect(headers['permissions-policy']).toMatch(/camera=\(\).*geolocation=\(\).*microphone=\(\).*payment=\(\).*usb=\(\)/u)
  expect(headers['permissions-policy']!.split(',').every((entry) => /^[a-z][a-z0-9-]*=\(\)$/u.test(entry.trim()))).toBe(true)
})

test('response-level frame-ancestors policy blocks same-origin framing', async ({ page, baseURL }) => {
  const origin = baseURL ?? 'http://127.0.0.1:4173'
  const harness = `${origin}/frame-harness`
  const framedResponse = page.waitForResponse((response) => response.url() === `${origin}${APP_PATH}`)
  await page.route(harness, (route) => route.fulfill({
    status: 200,
    contentType: 'text/html; charset=utf-8',
    body: `<!doctype html><html><body><iframe title="LineRecall framing probe" src="${origin}${APP_PATH}"></iframe></body></html>`,
  }))
  await page.goto(harness)
  expect((await framedResponse).status()).toBe(200)
  await page.waitForTimeout(250)
  const embeddedText = await page.getByTitle('LineRecall framing probe').evaluate((element: HTMLIFrameElement) =>
    element.contentDocument?.body?.textContent ?? '',
  )
  expect(embeddedText).not.toContain('LineRecall')
})
