import type { Page, TestInfo } from '@playwright/test'
import { ReviewBuildBindingSchema, REVIEW_BUILD_BINDING_PATH } from '../../scripts/e2e/review-build-binding.ts'
import { readHandleBoundRegularFile } from '../../scripts/lib/handle-bound-file.ts'
import { sha256Bytes } from '../../scripts/security/lib/files.ts'

/** Screenshots prove fixture behavior only. No attachment is a manual approval. */
export async function attachReviewScreenshot(
  page: Page,
  testInfo: TestInfo,
  name: string,
  options: Parameters<Page['screenshot']>[0] = { animations: 'disabled' },
): Promise<void> {
  const binding = ReviewBuildBindingSchema.parse(JSON.parse((await readHandleBoundRegularFile(
    REVIEW_BUILD_BINDING_PATH, 'Review browser build receipt', 1024 * 1024,
  )).toString('utf8')) as unknown)
  const environment = await page.evaluate(() => ({
    theme: document.documentElement.dataset.theme ?? (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'),
    reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches,
    forcedColors: matchMedia('(forced-colors: active)').matches,
    direction: getComputedStyle(document.documentElement).direction,
    route: location.pathname + location.search + location.hash,
  }))
  const body = await page.screenshot(options)
  await testInfo.attach(name, { body, contentType: 'image/png' })
  const { files: _files, ...identity } = binding
  await testInfo.attach(`${name}.receipt.json`, {
    body: JSON.stringify({
      ...identity,
      screenshot: { name, bytes: body.byteLength, sha256: sha256Bytes(body) },
      viewport: page.viewportSize(),
      browser: testInfo.project.use.browserName ?? 'chromium',
      ...environment,
      test: testInfo.title,
      manualApproval: false,
    }, null, 2),
    contentType: 'application/json',
  })
}
