/**
 * Traceability between docs/design/direction.md and src/styles/tokens.css.
 *
 * Both directions are checked. A token the document does not name fails, and a
 * colour the document names that the stylesheet is missing fails, so neither
 * file can move without the other.
 */
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

import { fromOklch, inSrgb, splitTriple, toHex } from './colour.ts'
import {
  colourTokens,
  files,
  filesUnder,
  parseCssTokens,
  parseDocumentColours,
  parseOklch,
  read,
  resolveToken,
} from './tokens.ts'

const document = parseDocumentColours(read(files.direction))
const css = parseCssTokens(read(files.tokens))

describe('the document and the stylesheet name the same colours', () => {
  it('parsed colours out of both files', () => {
    // A parser that quietly matched nothing would make every other test here
    // pass, so the two sides must at least agree and be the size the document
    // is: twenty-three rows in the palette tables plus four further tints.
    expect(document.size).toBeGreaterThanOrEqual(25)
    expect(colourTokens(css)).toHaveLength(document.size)

    for (const name of ['--bg-0', '--accent-ink', '--state-error', '--tint-vanished']) {
      expect(document.get(name), name).toBeDefined()
    }
  })

  it('declares every document colour in the stylesheet', () => {
    const missing = [...document.keys()].filter((name) => !css.has(name))
    expect(missing).toEqual([])
  })

  it('declares no colour the document does not name', () => {
    const invented = colourTokens(css).filter((name) => !document.has(name))
    expect(invented).toEqual([])
  })

  it('gives each colour the document value', () => {
    // Compared as numbers, not as text: 0.190 and 0.19 are the same value
    // written two ways, and only a real difference should fail.
    const wrong: string[] = []
    const same = (one: number, other: number): boolean => Math.abs(one - other) < 1e-9

    for (const [name, declared] of document) {
      const resolved = resolveToken(name, css)
      const parsed = resolved === null ? null : parseOklch(resolved)
      const expected = splitTriple(declared.oklch)

      if (parsed === null) {
        wrong.push(`${name}: not an oklch() value`)
        continue
      }
      if (!parsed.every((value, index) => same(value, expected[index] ?? Number.NaN))) {
        wrong.push(`${name}: ${parsed.join(' ')} in the stylesheet, ${declared.oklch} in the document`)
      }
    }

    expect(wrong).toEqual([])
  })

  it('keeps the three aliases, resolved', () => {
    // The document records these as the same value, not as a fourth colour
    // that happens to look identical.
    const aliases = {
      '--state-awaiting': '--accent',
      '--state-disabled': '--text-disabled',
      '--state-unsupported': '--state-indexing',
    } as const

    for (const [alias, target] of Object.entries(aliases)) {
      expect(css.get(alias), alias).toBe(`var(${target})`)
      expect(resolveToken(alias, css)).toBe(resolveToken(target, css))
    }
  })
})

describe('the document values are true', () => {
  it('converts every document OKLCH to the hex written beside it', () => {
    const wrong: string[] = []

    for (const [name, declared] of document) {
      const computed = toHex(fromOklch(declared.oklch))
      if (computed !== declared.hex.toUpperCase()) {
        wrong.push(`${name}: document says ${declared.hex}, the conversion is ${computed}`)
      }
    }

    expect(wrong).toEqual([])
  })

  it('keeps every colour inside sRGB', () => {
    const outside: string[] = []

    for (const [name, declared] of document) {
      if (!inSrgb(fromOklch(declared.oklch))) {
        outside.push(`${name} (${declared.oklch}) is outside sRGB`)
      }
    }

    for (const name of colourTokens(css)) {
      const resolved = resolveToken(name, css)
      if (resolved !== null && !inSrgb(fromOklch(splitTriple(resolved)))) {
        outside.push(`${name} in the stylesheet is outside sRGB`)
      }
    }

    expect(outside).toEqual([])
  })
})

describe('the stylesheet carries no fallback colour', () => {
  it('writes no hex literal in any stylesheet under src', () => {
    const offenders: string[] = []

    for (const path of filesUnder(files.src, (name) => name.endsWith('.css'))) {
      for (const match of read(path).matchAll(/#[0-9a-fA-F]{3,8}(?![0-9a-zA-Z_-])/g)) {
        offenders.push(`${path}: ${match[0]}`)
      }
    }

    expect(offenders).toEqual([])
  })

  it('writes no rgb() or hsl() literal either', () => {
    const offenders: string[] = []

    for (const path of filesUnder(files.src, (name) => name.endsWith('.css'))) {
      for (const match of read(path).matchAll(/\b(?:rgb|rgba|hsl|hsla)\s*\(/g)) {
        offenders.push(`${path}: ${match[0]}`)
      }
    }

    expect(offenders).toEqual([])
  })
})

describe('theme-color', () => {
  it('equals the ground token, and is the only hex outside the stylesheet', () => {
    const html = read(files.indexHtml)
    const meta = /<meta\s+name="theme-color"\s+content="(#[0-9A-Fa-f]{6})"\s*\/?>/.exec(html)
    expect(meta?.[1]).toBeDefined()

    const ground = resolveToken('--bg-0', css)
    expect(ground).not.toBeNull()
    expect(meta?.[1]?.toUpperCase()).toBe(toHex(fromOklch(splitTriple(ground ?? ''))))

    // Fonts are binaries. Scanning them as text is meaningless, so they are
    // skipped rather than decoded.
    const offenders: string[] = []
    for (const path of [files.indexHtml, ...filesUnder(files.src, isTextSource)]) {
      for (const match of read(path).matchAll(/#[0-9a-fA-F]{3,8}(?![0-9a-zA-Z_-])/g)) {
        if (path === files.indexHtml && match[0].toUpperCase() === meta?.[1]?.toUpperCase()) {
          continue
        }
        offenders.push(`${path}: ${match[0]}`)
      }
    }

    expect(offenders).toEqual([])
  })

  it('declares the dark colour scheme in metadata as well as on root', () => {
    expect(read(files.indexHtml)).toContain('<meta name="color-scheme" content="dark" />')
    expect(read(files.tokens)).toMatch(/:root\s*\{[^}]*color-scheme:\s*dark/)
  })
})

describe('the scales are usable as tokens', () => {
  it('states type and space in rem on the 16px baseline', () => {
    for (const name of ['--type-meta', '--type-label', '--type-body', '--type-lead']) {
      expect(css.get(name), name).toMatch(/^[\d.]+rem$/)
    }

    for (const name of ['--space-1', '--space-2', '--gutter-page', '--pad-panel', '--row-height']) {
      expect(css.get(name), name).toMatch(/^[\d.]+rem$/)
    }
  })

  it('names the three easings and the five durations and nothing else', () => {
    const easing = [...css.keys()].filter((name) => name.startsWith('--ease-'))
    expect(easing.sort()).toEqual(['--ease-drawer', '--ease-in-out', '--ease-out'])

    const durations = [...css.keys()].filter((name) => name.startsWith('--duration-'))
    expect(durations.sort()).toEqual([
      '--duration-ceiling',
      '--duration-feedback',
      '--duration-press',
      '--duration-settle',
      '--duration-state',
    ])

    for (const name of durations) {
      expect(css.get(name), name).toMatch(/^\d+ms$/)
    }
  })

  it('declares the layer order once', () => {
    const occurrences = read(files.tokens).match(/@layer\s+reset,\s*base,\s*components;/g) ?? []
    expect(occurrences).toHaveLength(1)
  })
})

/** Anything that is text: binaries such as .woff2 are not scanned as source. */
function isTextSource(name: string): boolean {
  return !/\.(?:woff2?|ttf|otf|eot|png|jpe?g|gif|webp|avif|ico|pdf)$/i.test(name)
}

describe('the stylesheet is loaded once, from the entry', () => {
  it('imports tokens before styles, and nothing else imports tokens', () => {
    const entry = resolve(files.src, 'main.tsx')
    const source = read(entry)
    const stylesheets = [...source.matchAll(/^import '([^']+\.css)'$/gm)].map((match) => match[1])

    // Order matters, and the list is exact rather than a subset: tokens first,
    // because the layer statement has to be evaluated before any stylesheet
    // that adds to a layer; then the faces; then the application stylesheet.
    expect(stylesheets).toEqual(['./styles/tokens.css', './styles/fonts.css', './styles.css'])

    for (const stylesheet of ['tokens.css', 'fonts.css']) {
      const importers = filesUnder(files.src, (name) => /\.(?:ts|tsx)$/.test(name)).filter((path) =>
        read(path).includes(stylesheet),
      )
      expect(importers, stylesheet).toEqual([entry])
    }
  })

  it('keeps index.html free of a stylesheet link', () => {
    expect(read(files.indexHtml)).not.toMatch(/<link[^>]+rel="stylesheet"/)
  })
})
