import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { viteSingleFile } from 'vite-plugin-singlefile'
import { readFileSync } from 'node:fs'

function embeddedSnapshotHtml(snapshotPath: string): import('vite').Plugin {
  return {
    name: 'linerecall-embedded-snapshot',
    transformIndexHtml: {
      order: 'pre',
      handler(html) {
        const marker = '<!-- linerecall-embedded-snapshot -->'
        if (html.split(marker).length !== 2) {
          throw new Error('The HTML must contain exactly one embedded-snapshot marker')
        }
        const rawSnapshot = readFileSync(snapshotPath, 'utf8').trim()
        JSON.parse(rawSnapshot) as unknown
        const snapshot = rawSnapshot
          // A script element is a raw-text context even when its type is inert.
          // Escaping every less-than sign preserves parsed JSON values while
          // making case-variant closing tags and comment openers impossible.
          .replaceAll('<', '\\u003c')
          .replaceAll('\u2028', '\\u2028')
          .replaceAll('\u2029', '\\u2029')
        return html.replace(
          marker,
          `<script id="linerecall-embedded-snapshot" type="application/json">${snapshot}</script>`,
        )
      },
    },
  }
}

function placeApplicationModuleAfterPrebootShell(): import('vite').Plugin {
  return {
    name: 'linerecall-preboot-first',
    enforce: 'post',
    generateBundle(_options, bundle) {
      const htmlAssets = Object.values(bundle).filter((output) =>
        output.type === 'asset' && output.fileName.endsWith('.html')
      )
      if (htmlAssets.length !== 1 || htmlAssets[0]?.type !== 'asset') {
        throw new Error('Expected exactly one generated LineRecall HTML asset')
      }

      const asset = htmlAssets[0]
      const html = String(asset.source)
      const modulePattern = /<script type="module" crossorigin>[\s\S]*?<\/script>/gu
      const modules = [...html.matchAll(modulePattern)]
      if (modules.length !== 1 || modules[0]?.index === undefined) {
        throw new Error(`Expected one inline application module, found ${modules.length}`)
      }

      const moduleBlock = modules[0][0]
      const withoutModule = `${html.slice(0, modules[0].index)}${html.slice(modules[0].index + moduleBlock.length)}`
      const snapshotStart = withoutModule.indexOf('<script id="linerecall-embedded-snapshot"')
      if (snapshotStart < 0) throw new Error('Embedded snapshot container is missing from the generated HTML')
      const snapshotEnd = withoutModule.indexOf('</script>', snapshotStart)
      if (snapshotEnd < 0) throw new Error('Embedded snapshot container is not closed')
      const insertionPoint = snapshotEnd + '</script>'.length

      // The static shell and its theme listener are now parsed and operable
      // before the browser pays the cost of parsing the application bundle.
      // Keeping the inert data block first also gives the renderer an earlier
      // opportunity to paint before JavaScript compilation begins.
      asset.source = `${withoutModule.slice(0, insertionPoint)}\n${moduleBlock}${withoutModule.slice(insertionPoint)}`
    },
  }
}

export function createLineRecallViteConfig(
  snapshotPath = 'src/generated/embedded-snapshot.json',
) {
  return defineConfig({
    plugins: [embeddedSnapshotHtml(snapshotPath), react(), viteSingleFile(), placeApplicationModuleAfterPrebootShell()],
    publicDir: false,
    build: {
      target: 'es2022',
      modulePreload: false,
      outDir: 'build/candidate',
      emptyOutDir: true,
      sourcemap: false,
      cssCodeSplit: false,
      assetsInlineLimit: 100_000_000,
      rollupOptions: {
        input: 'linerecall.html',
      },
    },
  })
}

export default createLineRecallViteConfig()
