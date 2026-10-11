/**
 * The vendored fonts, checked as bytes.
 *
 * The files are binaries. They are read as buffers and never decoded as text,
 * and every text scan over src skips them rather than pretending they are
 * source. The hashes are the approved ones, so a font swapped for another
 * build fails here even when it renders.
 */
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

import { productionBuild } from './build.ts'
import { files, filesUnder, parseNoticeFonts, parseCssTokens, read, resolveToken } from './tokens.ts'

const fontDir = resolve(files.src, 'fonts')

const approved = [
  {
    family: 'Geist Sans',
    file: 'geist-latin-wght-normal.woff2',
    bytes: 29_400,
    sha256: '19f9c92546aa300c312235e3125af1b81394d8db9a4bc4a425cd5b641d2d54e1',
    token: '--font-sans',
  },
  {
    family: 'Geist Mono',
    file: 'geist-mono-latin-wght-normal.woff2',
    bytes: 23_128,
    sha256: '684ad5b531f81d43c1e8c7038262d5db7cdc1f68006e04d6c7769efa8d33c8cc',
    token: '--font-mono',
  },
] as const

const fontFiles = filesUnder(fontDir, () => true)
const digest = (path: string): string =>
  createHash('sha256')
    .update(readFileSync(path))
    .digest('hex')

describe('the vendored files are the approved ones', () => {
  it('holds the two files and nothing else', () => {
    expect(fontFiles.map((path) => path.slice(fontDir.length + 1)).sort()).toEqual(
      approved.map((one) => one.file).sort(),
    )
  })

  it('matches the byte sizes', () => {
    for (const one of approved) {
      const path = resolve(fontDir, one.file)
      expect(readFileSync(path).byteLength, one.file).toBe(one.bytes)
    }
  })

  it('matches the SHA-256 of the bytes on disk', () => {
    for (const one of approved) {
      expect(digest(resolve(fontDir, one.file)), one.file).toBe(one.sha256)
    }
  })

  it('vendors no other font anywhere in the source tree', () => {
    const others = filesUnder(files.src, (name) => /\.(?:woff2?|ttf|otf|eot)$/i.test(name)).filter(
      (path) => !fontFiles.includes(path),
    )
    expect(others).toEqual([])
  })
})

describe('nothing else ships a font', () => {
  it('declares no font package', () => {
    const packageJson: unknown = JSON.parse(read(files.packageJson))
    const declared = JSON.stringify(packageJson)
    expect(declared).not.toContain('@fontsource')
    expect(declared).not.toContain('@font-face from a package')
  })

  it('fetches no font from a network location', () => {
    const sources = [
      resolve(files.src, 'styles/fonts.css'),
      files.indexHtml,
      ...filesUnder(files.src, (name) => /\.(?:css|ts|tsx)$/.test(name)),
    ]

    const offenders: string[] = []
    for (const path of sources) {
      const text = read(path)
      for (const match of text.matchAll(/url\(\s*['"]?([^'")]+)['"]?\s*\)/g)) {
        const target = match[1] ?? ''
        if (!target.endsWith('.woff2') || target.startsWith('/src/fonts/')) {
          continue
        }
        if (!target.startsWith('../fonts/')) {
          offenders.push(`${path}: ${target}`)
        }
      }
      if (/fonts\.googleapis|fonts\.gstatic|cdn\.|https?:\/\/[^'"]*\.woff2/.test(text)) {
        offenders.push(`${path}: a network font reference`)
      }
    }

    expect(offenders).toEqual([])
  })
})

describe('the faces are declared as agreed', () => {
  const fontsCss = read(resolve(files.src, 'styles/fonts.css'))

  it('declares one face per family, at the full weight range', () => {
    const faces = [...fontsCss.matchAll(/@font-face\s*\{([^}]*)\}/g)].map((match) => match[1] ?? '')
    expect(faces).toHaveLength(2)

    for (const one of approved) {
      const face = faces.find((block) => block.includes(`font-family: '${one.family}'`))
      expect(face, one.family).toBeDefined()
      expect(face).toContain('font-style: normal')
      expect(face).toContain('font-weight: 100 900')
      expect(face).toContain('font-display: swap')
      expect(face).toContain(`url('../fonts/${one.file}')`)
      expect(face).toContain("format('woff2-variations')")
    }
  })

  it('keeps the family tokens pointing at these names, with their fallbacks', () => {
    const tokens = parseCssTokens(read(files.tokens))
    expect(resolveToken('--font-sans', tokens)).toBe('"Geist Sans", system-ui, sans-serif')
    expect(resolveToken('--font-mono', tokens)).toBe('"Geist Mono", ui-monospace, monospace')
  })
})

describe('the preload', () => {
  const html = read(files.indexHtml)

  it('preloads the sans once, as a font, with crossorigin', () => {
    const preloads = [...html.matchAll(/<link[^>]*rel="preload"[^>]*>/g)].map((match) => match[0])
    expect(preloads).toHaveLength(1)

    const preload = preloads[0] ?? ''
    expect(preload).toContain(`href="/src/fonts/${approved[0].file}"`)
    expect(preload).toContain('as="font"')
    expect(preload).toContain('type="font/woff2"')
    expect(preload).toContain('crossorigin')
  })

  it('does not preload the mono face', () => {
    expect(html).not.toContain(approved[1].file)
  })
})

describe('the notice matches the files', () => {
  it('records the same sizes and hashes as the bytes on disk', () => {
    const documented = parseNoticeFonts(read(files.notice))
    expect(documented.size).toBe(2)

    for (const one of approved) {
      const entry = documented.get(one.file)
      expect(entry, one.file).toBeDefined()
      expect(entry?.bytes, one.file).toBe(String(one.bytes))
      expect(entry?.sha256, one.file).toBe(one.sha256)
    }
  })

  it('names the source packages and versions', () => {
    const notice = read(files.notice)
    expect(notice).toContain('@fontsource-variable/geist')
    expect(notice).toContain('@fontsource-variable/geist-mono')
    expect(notice).toContain('5.3.0')
  })

  it('carries the copyright line and the complete license', () => {
    const notice = read(files.notice)
    expect(notice).toContain(
      'Copyright 2024 The Geist Project Authors (https://github.com/vercel/geist-font)',
    )
    expect(notice).toContain('SIL OPEN FONT LICENSE Version 1.1 - 26 February 2007')
    expect(notice).toContain('PERMISSION & CONDITIONS')
    expect(notice).toContain('OTHER DEALINGS IN THE FONT SOFTWARE.')
  })
})

describe('the preload and the build agree', () => {
  it('points the production HTML and CSS at the same hashed file', async () => {
    const { html, css, assets } = await productionBuild()

    const preloaded = /<link[^>]+rel="preload"[^>]+href="([^"]+\.woff2)"[^>]*>/.exec(html)?.[1]
    expect(preloaded, 'the built HTML has no font preload').toBeDefined()

    // The stylesheet names the sans in its own url(); both must resolve to the
    // one emitted asset, not to two copies of the same bytes.
    const loaded = [...css.matchAll(/url\(([^)]+\.woff2)\)/g)].map((match) => match[1] ?? '')
    expect(loaded).toContain(preloaded)

    const name = (preloaded ?? '').split('/').pop() ?? ''
    const asset = [...assets].find(([fileName]) => fileName.endsWith(name))?.[1]
    expect(asset, `${String(preloaded)} was not emitted`).toBeDefined()
    expect(createHash('sha256').update(asset ?? Buffer.alloc(0)).digest('hex')).toBe(
      approved[0].sha256,
    )

    // The mono face is loaded when it is used, and never preloaded.
    expect(loaded.some((url) => url.includes('geist-mono'))).toBe(true)
    expect(html).not.toContain('geist-mono')
  }, 120_000)
})
