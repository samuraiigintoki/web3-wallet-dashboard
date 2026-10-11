/**
 * The gate library stays a gate.
 *
 * colorjs.io is a devDependency the tests and the contrast gate use. It must
 * not reach the application bundle, and this builds the real application to
 * say so rather than trusting a scan that could miss it.
 */
import { describe, expect, it } from 'vitest'

import { productionBuild } from './build.ts'

describe('production output', () => {
  it('contains no trace of colorjs.io', async () => {
    const { assets } = await productionBuild()

    let text = ''
    for (const [name, bytes] of assets) {
      if (/\.(?:js|css)$/.test(name)) {
        text += bytes.toString('utf8')
      }
    }

    expect(text.length).toBeGreaterThan(0)
    for (const marker of ['colorjs', 'contrastAPCA', 'ColorSpace', 'toGamut']) {
      expect(text, marker).not.toContain(marker)
    }
  }, 120_000)
})
