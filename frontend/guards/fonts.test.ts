/**
 * The vendored fonts, checked as bytes.
 *
 * The files are binaries. They are read as buffers and never decoded as text,
 * and every text scan over src skips them rather than pretending they are
 * source. The hashes are the approved ones, so a font swapped for another
 * build fails here even when it renders.
 *
 * Three families, three roles, recorded in docs/design/direction.md: Fraunces
 * is the display face, Archivo carries the interface, and Martian Mono is for
 * raw chain values. Each is followed by a fallback face whose metric overrides
 * are measured values; the guard checks that the overrides are declared on the
 * fallback and not on the vendored face, which would be meaningless.
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
    family: 'Fraunces',
    role: 'display',
    file: 'fraunces-latin-soft-wonk.woff2',
    bytes: 121_016,
    sha256: '7e744849028e2219e2aa1bc467dc4032980dc4487c9c3da3010081cd72d3b103',
    token: '--font-display',
    fallback: 'Fraunces Fallback',
  },
  {
    family: 'Archivo',
    role: 'interface',
    file: 'archivo-latin-wght.woff2',
    bytes: 34_928,
    sha256: '8f704806dbedeaaeca334b11ec348bc3ac3a439d6431544b3afb54f534ee4967',
    token: '--font-sans',
    fallback: 'Archivo Fallback',
  },
  {
    family: 'Martian Mono',
    role: 'raw values',
    file: 'martian-mono-latin-wght.woff2',
    bytes: 23_556,
    sha256: 'd0be3a78a854bcea53a9dc26b6620ba322eaa515ccbd92bb4b6ec20a3c91b291',
    token: '--font-mono',
    fallback: 'Martian Mono Fallback',
  },
] as const

/** Preloaded in index.html: the two faces the first paint needs. */
const preloaded = [approved[1], approved[0]]

const fontFiles = filesUnder(fontDir, () => true)
const digest = (path: string): string =>
  createHash('sha256')
    .update(readFileSync(path))
    .digest('hex')

describe('the vendored files are the approved ones', () => {
  it('holds the three files and nothing else', () => {
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

  it('carries no candidate B file and no earlier interim file', () => {
    const names = fontFiles.map((path) => path.slice(fontDir.length + 1).toLowerCase())
    expect(names.some((name) => name.includes('unbounded'))).toBe(false)
    expect(names.some((name) => name.includes('geist'))).toBe(false)
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
  const faces = [...fontsCss.matchAll(/@font-face\s*\{([^}]*)\}/g)].map((match) => match[1] ?? '')

  it('declares one vendored face and one fallback face per family', () => {
    expect(faces).toHaveLength(6)

    for (const one of approved) {
      const face = faces.find((block) => block.includes(`font-family: '${one.family}'`))
      expect(face, one.family).toBeDefined()
      expect(face).toContain('font-style: normal')
      expect(face).toContain('font-display: swap')
      expect(face).toContain(`url('../fonts/${one.file}')`)
      expect(face).toContain("format('woff2-variations')")
      // A metric override on the vendored face would be meaningless.
      expect(face).not.toContain('size-adjust')
    }
  })

  it('gives the display and interface faces a full range and the mono a real one', () => {
    const range = (family: string): string =>
      /font-weight:\s*([\d ]+);/.exec(
        faces.find((block) => block.includes(`font-family: '${family}'`)) ?? '',
      )?.[1]?.trim() ?? ''
    expect(range('Fraunces')).toBe('100 900')
    expect(range('Archivo')).toBe('100 900')
    expect(range('Martian Mono')).toBe('100 800')
  })

  it('measures a fallback face per family, with all three overrides', () => {
    for (const one of approved) {
      const face = faces.find((block) => block.includes(`font-family: '${one.fallback}'`))
      expect(face, one.fallback).toBeDefined()
      expect(face).toMatch(/src:\s*local\(/)
      expect(face).toMatch(/size-adjust:\s*\d+(?:\.\d+)?%/)
      expect(face).toMatch(/ascent-override:\s*\d+(?:\.\d+)?%/)
      expect(face).toMatch(/descent-override:\s*\d+(?:\.\d+)?%/)
      expect(face).toContain('line-gap-override: 0%')
    }
  })

  it('keeps the family tokens pointing at the vendored face, its fallback and locals', () => {
    const tokens = parseCssTokens(read(files.tokens))
    expect(resolveToken('--font-display', tokens)).toBe(
      '"Fraunces", "Fraunces Fallback", "Times New Roman", Times, serif',
    )
    expect(resolveToken('--font-sans', tokens)).toBe(
      '"Archivo", "Archivo Fallback", Arial, Helvetica, sans-serif',
    )
    expect(resolveToken('--font-mono', tokens)).toBe(
      '"Martian Mono", "Martian Mono Fallback", "Courier New", Courier, monospace',
    )
  })
})

describe('the preload', () => {
  const html = read(files.indexHtml)

  it('preloads the interface face and the display face, each once, with crossorigin', () => {
    const preloads = [...html.matchAll(/<link[^>]*rel="preload"[^>]*>/g)].map((match) => match[0])
    expect(preloads).toHaveLength(2)

    for (const one of preloaded) {
      const preload = preloads.find((tag) => tag.includes(one.file))
      expect(preload, one.file).toBeDefined()
      expect(preload).toContain('as="font"')
      expect(preload).toContain('type="font/woff2"')
      expect(preload).toContain('crossorigin')
    }
  })

  it('does not preload the mono face', () => {
    expect(html).not.toContain(approved[2].file)
  })
})

describe('the notice matches the files', () => {
  it('records the same sizes and hashes as the bytes on disk', () => {
    const documented = parseNoticeFonts(read(files.notice))
    expect(documented.size).toBe(3)

    for (const one of approved) {
      const entry = documented.get(one.file)
      expect(entry, one.file).toBeDefined()
      expect(entry?.bytes, one.file).toBe(String(one.bytes))
      expect(entry?.sha256, one.file).toBe(one.sha256)
    }
  })

  it('names the source and the version of each family', () => {
    const notice = read(files.notice)
    expect(notice).toContain('fonts.googleapis.com')
    for (const version of ['v38', 'v25', 'v6']) {
      expect(notice).toContain(version)
    }
  })

  it('carries the copyright lines and the complete license', () => {
    const notice = read(files.notice)
    expect(notice).toContain(
      'Copyright 2018 The Fraunces Project Authors (https://github.com/undercasetype/Fraunces)',
    )
    expect(notice).toContain(
      'Copyright 2020 The Archivo Project Authors (https://github.com/Omnibus-Type/Archivo)',
    )
    expect(notice).toContain(
      'Copyright 2021 The Martian Mono Project Authors (https://github.com/evilmartians/mono)',
    )
    expect(notice).toContain('SIL OPEN FONT LICENSE Version 1.1 - 26 February 2007')
    expect(notice).toContain('PERMISSION & CONDITIONS')
    expect(notice).toContain('OTHER DEALINGS IN THE FONT SOFTWARE.')
  })
})

describe('the preload and the build agree', () => {
  it('points the production HTML and CSS at the same hashed files', async () => {
    const { html, css, assets } = await productionBuild()

    const preloadedUrls = [
      ...html.matchAll(/<link[^>]+rel="preload"[^>]+href="([^"]+\.woff2)"[^>]*>/g),
    ].map((match) => match[1] ?? '')
    expect(preloadedUrls).toHaveLength(2)

    const loaded = [...css.matchAll(/url\(([^)]+\.woff2)\)/g)].map((match) => match[1] ?? '')
    // Every vendored face is emitted and named by the stylesheet.
    for (const one of approved) {
      const stem = one.file.split('-')[0] ?? ''
      expect(
        loaded.some((url) => url.includes(stem)),
        one.file,
      ).toBe(true)
    }

    // Every preload resolves to an emitted asset whose bytes are the approved ones.
    for (const one of preloaded) {
      const url = preloadedUrls.find((candidate) => candidate.includes(one.file.replace(/\.woff2$/, '')))
      expect(url, `no preload for ${one.file}`).toBeDefined()
      const name = (url ?? '').split('/').pop() ?? ''
      const asset = [...assets].find(([fileName]) => fileName.endsWith(name))?.[1]
      expect(asset, `${String(url)} was not emitted`).toBeDefined()
      expect(createHash('sha256').update(asset ?? Buffer.alloc(0)).digest('hex')).toBe(one.sha256)
    }

    // The mono face is loaded when it is used, and never preloaded.
    expect(loaded.some((url) => url.includes('martian'))).toBe(true)
    expect(html).not.toContain('martian')
  }, 120_000)
})
