/**
 * The gate library stays a gate.
 *
 * colorjs.io is a devDependency the tests and the contrast gate use. It must
 * not reach the application bundle, and this builds the real application to
 * say so rather than trusting a scan that could miss it.
 */
import { describe, expect, it } from 'vitest'
import { build } from 'vite'

import { files } from './tokens.ts'

async function productionBundle(): Promise<string> {
  const result = await build({
    root: files.src + '/..',
    logLevel: 'silent',
    build: { write: false, minify: true },
  })

  const outputs = Array.isArray(result) ? result : [result]
  let code = ''

  for (const output of outputs) {
    // A watch build returns a watcher rather than an output; this never asks
    // for one, and the narrowing keeps the type honest.
    if (!('output' in output)) {
      continue
    }

    for (const item of output.output) {
      if (item.type === 'chunk') {
        code += item.code
      } else if (typeof item.source === 'string') {
        code += item.source
      } else {
        code += Buffer.from(item.source).toString('utf8')
      }
    }
  }

  return code
}

describe('production output', () => {
  it('contains no trace of colorjs.io', async () => {
    const code = await productionBundle()
    expect(code.length).toBeGreaterThan(0)

    for (const marker of ['colorjs', 'contrastAPCA', 'ColorSpace', 'toGamut']) {
      expect(code, marker).not.toContain(marker)
    }
  }, 120_000)
})
