/**
 * The motion rules, over the stylesheets that animate anything.
 *
 * The direction allows transform and opacity, bans `transition: all` and
 * `ease-in`, names three easing tokens, and records one exception: a
 * continuously turning working indicator may use `linear`, because an eased
 * rotation reads as a stutter. A media query cannot be exercised in jsdom, so
 * the rule that implements it is read here instead.
 */
import { describe, expect, it } from 'vitest'

import { files, filesUnder, read } from './tokens.ts'

const stylesheets = filesUnder(files.src, (name) => name.endsWith('.css')).map((path) => ({
  path,
  css: read(path),
}))

const animated = stylesheets.filter(({ css }) => /animation:|transition:/.test(css))

/** The easing tokens the direction names, plus the one documented exception. */
const EASING_TOKEN = /var\(--ease-[a-z]+\)/
const RAW_CURVES = /(?:^|[\s,])(ease|ease-in|ease-out|ease-in-out|linear|steps|step-start|step-end|cubic-bezier|spring)\(?/

const isSpinner = (path: string): boolean => path.endsWith('Spinner.module.css')

/** Every easing written into a transition or an animation, with its sheet. */
function easings(): { path: string; value: string }[] {
  const found: { path: string; value: string }[] = []

  for (const { path, css } of stylesheets) {
    for (const match of css.matchAll(/(?:transition|animation)(?:-timing-function)?:\s*([^;]+);/g)) {
      const value = (match[1] ?? '').trim()
      // `none` is the reduced motion switch, not an easing.
      if (value !== 'none') {
        found.push({ path, value })
      }
    }
  }

  return found
}

/** The declarations inside each keyframes block, by brace matching a block. */
function keyframeDeclarations(): { path: string; name: string; properties: string[] }[] {
  const found: { path: string; name: string; properties: string[] }[] = []

  for (const { path, css } of stylesheets) {
    for (const match of css.matchAll(/@keyframes\s+([\w-]+)\s*\{/g)) {
      const open = (match.index ?? 0) + match[0].length - 1
      let depth = 1
      let cursor = open + 1
      while (cursor < css.length && depth > 0) {
        if (css[cursor] === '{') {
          depth += 1
        } else if (css[cursor] === '}') {
          depth -= 1
        }
        cursor += 1
      }

      // Only the declarations directly inside the steps, not anything after.
      const body = css.slice(open + 1, cursor - 1)
      const properties: string[] = []
      for (const step of body.matchAll(/\{([^{}]*)\}/g)) {
        for (const declaration of (step[1] ?? '').matchAll(/([\w-]+)\s*:/g)) {
          properties.push(declaration[1] ?? '')
        }
      }

      found.push({ path, name: match[1] ?? '', properties })
    }
  }

  return found
}

describe('what is allowed to move', () => {
  it('finds the stylesheets that animate', () => {
    expect(animated.length).toBeGreaterThan(0)
    expect(keyframeDeclarations().length).toBeGreaterThan(0)
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

  it('animates transform and opacity only', () => {
    // A rotation is a transform. Nothing animates a colour, a size or a
    // position, because none of those can be handed to the compositor.
    const offenders: string[] = []

    for (const { path, name, properties } of keyframeDeclarations()) {
      for (const property of properties) {
        if (!['transform', 'opacity'].includes(property)) {
          offenders.push(`${path}: @keyframes ${name} sets ${property}`)
        }
      }
    }

    expect(offenders).toEqual([])
  })

  it('names an easing token everywhere except the documented spinner', () => {
    const offenders: string[] = []
    let exceptionUsed = 0

    for (const { path, value } of easings()) {
      // A duration token is required wherever an easing is written, and the
      // easing itself is a token, unless this is the rotation.
      if (isSpinner(path) && /\blinear\b/.test(value)) {
        exceptionUsed += 1
        continue
      }
      if (!EASING_TOKEN.test(value)) {
        offenders.push(`${path}: ${value} names no easing token`)
      }
    }

    expect(offenders).toEqual([])
    // The exception is in use, and used in exactly one place.
    expect(exceptionUsed).toBe(1)
  })

  it('keeps the shell frame free of entrance motion', () => {
    // A screen arriving is not an event: nothing animates on navigation or on
    // mount, so the frame declares no animation and no keyframes at all. The
    // authored moment is reserved for the block-time rail.
    const shell = stylesheets.find(({ path }) => path.endsWith('Shell.module.css'))
    expect(shell).toBeDefined()
    expect(shell?.css ?? '').not.toMatch(/animation:|@keyframes/)
  })

  it('rejects a raw curve or keyword anywhere else', () => {
    const offenders: string[] = []

    for (const { path, value } of easings()) {
      if (isSpinner(path) && /\blinear\b/.test(value)) {
        continue
      }
      const stripped = value.replace(/var\(--[a-z-]+\)/g, '')
      if (RAW_CURVES.test(stripped)) {
        offenders.push(`${path}: ${value}`)
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

  it('uses the duration tokens rather than numbers of its own', () => {
    const offenders: string[] = []

    for (const { path, css } of stylesheets) {
      if (path.endsWith('tokens.css')) {
        continue
      }
      for (const match of css.matchAll(/(?:transition|animation)(?:-duration)?:\s*([^;]+);/g)) {
        const value = match[1] ?? ''
        if (/none/.test(value)) {
          continue
        }
        if (!/var\(--duration-[a-z]+\)/.test(value)) {
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

    const reduced = /@media \(prefers-reduced-motion: reduce\) \{([\s\S]*?)\n  \}/.exec(
      spinner?.css ?? '',
    )?.[1]
    expect(reduced).toBeDefined()
    expect(reduced).toContain('animation: none')
  })

  it('stops the press transform', () => {
    const button = stylesheets.find(({ path }) => path.endsWith('Button.module.css'))
    const reduced = /@media \(prefers-reduced-motion: reduce\) \{([\s\S]*?)\n  \}/.exec(
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

describe('the exception is documented where it is claimed to be', () => {
  it('records linear in the direction, for the turning indicator only', () => {
    const direction = read(files.direction)
    const recorded = /`linear`[^.]*\./.exec(direction)?.[0] ?? ''

    expect(recorded).not.toBe('')
    expect(recorded).toMatch(/working indicator|turning/)
    expect(recorded).toMatch(/nowhere else|nothing else|one place/i)
  })
})
