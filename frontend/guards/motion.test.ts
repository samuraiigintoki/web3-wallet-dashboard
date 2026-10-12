/**
 * The motion rules, over the stylesheets that animate anything.
 *
 * The direction allows transform and opacity, bans `transition: all` and
 * `ease-in`, and requires everything that moves more than a few pixels to
 * respect a reduced motion preference. A media query cannot be exercised in
 * jsdom, so the rule that implements it is read here instead.
 */
import { describe, expect, it } from 'vitest'

import { files, filesUnder, read } from './tokens.ts'

const stylesheets = filesUnder(files.src, (name) => name.endsWith('.css')).map((path) => ({
  path,
  css: read(path),
}))

const animated = stylesheets.filter(({ css }) => /animation:|transition:/.test(css))

describe('what is allowed to move', () => {
  it('finds the stylesheets that animate', () => {
    expect(animated.length).toBeGreaterThan(0)
  })

  it('transitions transform and opacity only, never everything', () => {
    const offenders: string[] = []

    for (const { path, css } of stylesheets) {
      for (const match of css.matchAll(/transition:\s*([^;]+);/g)) {
        const value = match[1] ?? ''
        if (/\ball\b/.test(value)) {
          offenders.push(`${path}: transition: ${value}`)
          continue
        }
        if (!/\bnone\b/.test(value) && !/\b(?:transform|opacity)\b/.test(value)) {
          offenders.push(`${path}: transition: ${value}`)
        }
      }
    }

    expect(offenders).toEqual([])
  })

  it('never eases in on an interface element', () => {
    const offenders: string[] = []

    for (const { path, css } of stylesheets) {
      // --ease-in-out is a token name, not a curve applied on its own. What is
      // banned is the bare ease-in keyword.
      if (/(?<![\w-])ease-in(?![\w-])/.test(css)) {
        offenders.push(path)
      }
    }

    expect(offenders).toEqual([])
  })

  it('uses the duration and easing tokens rather than numbers of its own', () => {
    const offenders: string[] = []

    for (const { path, css } of stylesheets) {
      if (path.endsWith('tokens.css')) {
        continue
      }
      const animated = /(?:transition|animation):([^;]+);/g
      for (const match of css.matchAll(animated)) {
        const value = match[1] ?? ''
        if (/none/.test(value)) {
          continue
        }
        if (!/var\(--(?:duration|ease)-[a-z]+\)/.test(value)) {
          offenders.push(`${path}: ${value.trim()}`)
        }
      }
      for (const match of css.matchAll(/animation-duration:\s*([^;]+);/g)) {
        offenders.push(`${path}: animation-duration ${match[1] ?? ''}`)
      }
    }

    expect(offenders).toEqual([])
  })
})

describe('reduced motion', () => {
  it('stops the spinner', () => {
    const spinner = stylesheets.find(({ path }) => path.endsWith('Spinner.module.css'))
    expect(spinner).toBeDefined()

    const reduced = /@media \(prefers-reduced-motion: reduce\) \{([\s\S]*?)\n\}/.exec(
      spinner?.css ?? '',
    )?.[1]
    expect(reduced).toBeDefined()
    expect(reduced).toContain('animation: none')
  })

  it('stops the press transform', () => {
    const button = stylesheets.find(({ path }) => path.endsWith('Button.module.css'))
    const reduced = /@media \(prefers-reduced-motion: reduce\) \{([\s\S]*?)\n\}/.exec(
      button?.css ?? '',
    )?.[1]

    expect(reduced).toBeDefined()
    expect(reduced).toContain('transition: none')
    expect(reduced).toContain('transform: none')
  })

  it('keeps colour changes immediate', () => {
    // Nothing transitions a background or a foreground, so a state change is
    // visible the moment it happens.
    const offenders: string[] = []

    for (const { path, css } of stylesheets) {
      for (const match of css.matchAll(/transition:\s*([^;]+);/g)) {
        if (/(?:background|color|fill|stroke|border)/.test(match[1] ?? '')) {
          offenders.push(`${path}: ${match[0]}`)
        }
      }
    }

    expect(offenders).toEqual([])
  })
})
