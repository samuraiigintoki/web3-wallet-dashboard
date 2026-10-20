/**
 * A production build, held in memory.
 *
 * Two guards need the real build: one to prove the measuring library stays out
 * of the bundle, one to prove the preloaded font is the font the stylesheet
 * loads. Both read it from here rather than building a second time.
 */
import { build } from 'vite'

import { files } from './tokens.ts'

export type ProductionBuild = {
  html: string
  css: string
  assets: Map<string, Buffer>
}

export async function productionBuild(): Promise<ProductionBuild> {
  const result = await build({
    root: files.src + '/..',
    logLevel: 'silent',
    build: { write: false, minify: true },
  })

  const outputs = Array.isArray(result) ? result : [result]
  const assets = new Map<string, Buffer>()
  let html = ''
  let css = ''

  for (const output of outputs) {
    // A watch build returns a watcher rather than an output; this never asks
    // for one, and the narrowing keeps the type honest.
    if (!('output' in output)) {
      continue
    }

    for (const item of output.output) {
      const bytes =
        item.type === 'chunk'
          ? Buffer.from(item.code, 'utf8')
          : typeof item.source === 'string'
            ? Buffer.from(item.source, 'utf8')
            : Buffer.from(item.source)

      assets.set(item.fileName, bytes)
      if (item.fileName.endsWith('.css')) {
        css += bytes.toString('utf8')
      }
      if (item.fileName.endsWith('.html')) {
        html += bytes.toString('utf8')
      }
    }
  }

  return { html, css, assets }
}
