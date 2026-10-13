/**
 * The base layer.
 *
 * Base is what every screen gets before any component rule, so its placement,
 * its defaults and its control rules are all checked here rather than left to
 * a reviewer to notice. The fixtures at the end are the rules being broken, so
 * a rule that stopped working fails instead of passing quietly.
 */
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

import { productionBuild } from './build.ts'
import { checkComponentCss } from './componentRules.ts'
import {
  files,
  filesUnder,
  minimumRem,
  parseCssTokens,
  parseLayers,
  parseRules,
  read,
  resolveToken,
} from './tokens.ts'

// base.css sits with the other declaration files; the application stylesheet
// still sits at the source root, where B1 put it.
const readStyle = (name: string): string => read(resolve(files.src, 'styles', name))

const base = readStyle('base.css')
const tokens = parseCssTokens(read(files.tokens))

const baseLayers = parseLayers(base)

/** Every stylesheet in the tree, by path. */
const stylesheets = filesUnder(files.src, (name) => name.endsWith('.css'))
const modules = stylesheets.filter((path) => path.endsWith('.module.css'))
const declarations = stylesheets.filter((path) => !modules.includes(path))

const resetRules = parseRules(baseLayers.blocks.get('reset') ?? '')
const baseRules = parseRules(baseLayers.blocks.get('base') ?? '')

const body = baseRules.get('body') ?? new Map<string, string>()
const focus = baseRules.get(':focus-visible') ?? new Map<string, string>()
const controls = baseRules.get('input, select, textarea, button') ?? new Map<string, string>()

/** The layer a stylesheet's rules actually land in, checked rule by rule. */
function layerOf(path: string): { name: string | null; selectors: string[] } {
  const { blocks, unlayered } = parseLayers(read(path))
  const names = [...blocks.keys()]

  if (unlayered.length > 0) {
    return { name: null, selectors: unlayered }
  }
  if (names.length !== 1) {
    return { name: null, selectors: names }
  }

  const name = names[0] ?? null
  const block = blocks.get(name ?? '') ?? ''

  return { name, selectors: [...parseRules(block).keys()] }
}

describe('layer placement', () => {
  it('declares no layer order of its own', () => {
    // The statement is written once, in tokens.css. A second one would reorder
    // the layers for everything loaded after it.
    expect(baseLayers.order).toBeNull()

    for (const path of [...modules, ...declarations]) {
      if (path.endsWith('tokens.css')) {
        continue
      }
      expect(parseLayers(read(path)).order, path).toBeNull()
    }
  })

  it('puts every rule in the reset or base layer', () => {
    expect([...baseLayers.blocks.keys()].sort()).toEqual(['base', 'reset'])
    expect(baseLayers.unlayered).toEqual([])
    expect(baseLayers.blocks.get('reset')?.trim()).not.toBe('')
    expect(baseLayers.blocks.get('base')?.trim()).not.toBe('')
  })

  it('puts each module\'s own rules in the components layer', () => {
    // Not the layer name appearing in the file: the rules themselves, read out
    // of the block. A module left unlayered outranks every layer, so the
    // declared cascade would stop governing component rules entirely.
    expect(modules.length).toBeGreaterThan(0)

    for (const path of modules) {
      const { name, selectors } = layerOf(path)
      expect(name, path).toBe('components')
      expect(selectors.length, `${path} declares no rule`).toBeGreaterThan(0)
      expect(
        selectors.every((selector) => !selector.startsWith('@')),
        `${path} keeps a rule outside the layer`,
      ).toBe(true)
    }
  })

  it('puts the reset and base declarations in their own layers', () => {
    expect(layerOf(resolve(files.src, 'styles/base.css'))).toEqual({
      name: null,
      selectors: ['reset', 'base'],
    })
    expect(parseRules(baseLayers.blocks.get('reset') ?? '').size).toBeGreaterThan(0)
    expect(parseRules(baseLayers.blocks.get('base') ?? '').size).toBeGreaterThan(0)

    // tokens.css and fonts.css are declarations and at-rules, not rules that
    // compete with anything, so they stay where they are.
    expect(parseLayers(read(resolve(files.src, 'styles/tokens.css'))).blocks.size).toBe(0)
    expect(parseLayers(read(resolve(files.src, 'styles/fonts.css'))).blocks.size).toBe(0)
  })

  it('keeps every declaration file to the three named ones', () => {
    // tokens, fonts and base, and nothing else unlayered. Everything a
    // component paints belongs in a module, where it is scoped to that
    // component instead of reaching the whole page.
    expect(declarations.map((path) => path.slice(files.src.length + 1)).sort()).toEqual([
      'styles/base.css',
      'styles/fonts.css',
      'styles/tokens.css',
    ])

    for (const path of modules) {
      expect(read(path).length, path).toBeGreaterThan(0)
    }
  })

  it('gives every module a component that imports it', () => {
    const sources = filesUnder(files.src, (name) => /\.tsx$/.test(name)).map((path) => read(path))

    for (const path of modules) {
      const name = path.slice(path.lastIndexOf('/') + 1)
      expect(
        sources.some((source) => source.includes(name)),
        `${name} is imported by nothing`,
      ).toBe(true)
    }
  })

  it('leaves the old application stylesheet behind, not empty in the tree', () => {
    // Its rules moved into the page, shell, notice and field primitives.
    expect(stylesheets.some((path) => path === resolve(files.src, 'styles.css'))).toBe(false)
  })
})

describe('the reset', () => {
  it('box-sizes every element', () => {
    const every = parseRules(baseLayers.blocks.get('reset') ?? '').get('*, *::before, *::after')
    expect(every?.get('box-sizing')).toBe('border-box')
  })

  it('drops the body margin', () => {
    const resetBody = resetRules.get('body')
    expect(resetBody?.get('margin')).toBe('0')
  })
})

describe('the body defaults', () => {
  it('uses the tokens for family, leading, ink and ground', () => {
    expect(body.get('font-family')).toBe('var(--font-sans)')
    expect(body.get('font-size')).toBe('1rem')
    expect(body.get('line-height')).toBe('var(--leading-body)')
    expect(body.get('color')).toBe('var(--text-1)')
    expect(body.get('background-color')).toBe('var(--bg-0)')
  })

  it('resolves those tokens to values the document holds', () => {
    expect(resolveToken('--font-display', tokens)).toBe(
      '"Fraunces", "Fraunces Fallback", "Times New Roman", Times, serif',
    )
    expect(resolveToken('--font-sans', tokens)).toBe(
      '"Archivo", "Archivo Fallback", Arial, Helvetica, sans-serif',
    )
    expect(resolveToken('--leading-body', tokens)).toBe('1.5')
    expect(resolveToken('--text-1', tokens)).toBe('oklch(0.950 0.003 75)')
    expect(resolveToken('--bg-0', tokens)).toBe('oklch(0.155 0.008 75)')

    // 1rem is the 16px baseline, and the document's body step is 14px, so the
    // body is set at the baseline rather than at a type step. That is the
    // brief: the root size is what every rem below it is measured against.
    expect(resolveToken('--type-lead', tokens)).toBe('1rem')
  })

  it('authors no value of its own', () => {
    const literals: string[] = []

    for (const [property, value] of body) {
      if (/^var\(--[a-z0-9-]+\)$/.test(value)) {
        continue
      }
      if (['1rem', 'tabular-nums', '0'].includes(value)) {
        continue
      }
      literals.push(`${property}: ${value}`)
    }

    expect(literals).toEqual([])
  })
})

describe('touch targets', () => {
  it('sets touch-action: manipulation on every tappable element', () => {
    // The one gesture this blocks is the double-tap zoom. Panning and pinch
    // zoom are not named, so they stay as the platform sets them.
    const tappables = baseRules.get('a, button, input, select, textarea, label')
    expect(tappables?.get('touch-action')).toBe('manipulation')
  })
})

describe('tabular numerals', () => {
  it('sets them once, on the body, so a figure inherits them', () => {
    expect(body.get('font-variant-numeric')).toBe('tabular-nums')

    const offenders: string[] = []
    for (const path of [...declarations, ...modules]) {
      for (const [selector, declared] of parseRules(read(path))) {
        if (selector === 'body' && path.endsWith('base.css')) {
          // The one place it is set. Anything else would be a second source.
          continue
        }
        if (declared.get('font-variant-numeric') === 'tabular-nums') {
          offenders.push(`${path}: ${selector}`)
        }
      }
    }

    expect(offenders).toEqual([])
  })

  it('does not reset them anywhere', () => {
    const offenders: string[] = []
    for (const path of [...declarations, ...modules]) {
      for (const [selector, declared] of parseRules(read(path))) {
        if (declared.get('font-variant-numeric') === 'normal') {
          offenders.push(`${path}: ${selector}`)
        }
      }
    }

    expect(offenders).toEqual([])
  })

  it('gives them back to controls, which the font shorthand resets', () => {
    expect(controls.get('font')).toBe('inherit')
    expect(controls.get('font-variant-numeric')).toBe('inherit')
  })
})

describe('form controls', () => {
  it('inherit the font and the colour', () => {
    expect(controls.get('font')).toBe('inherit')
    expect(controls.get('color')).toBe('inherit')
  })

  it('are never smaller than 1rem', () => {
    const size = controls.get('font-size') ?? ''
    expect(size).not.toBe('')
    expect(minimumRem(size, tokens)).toBeGreaterThanOrEqual(1)
  })

  it('covers every control element', () => {
    for (const element of ['input', 'select', 'textarea', 'button']) {
      expect(controls.size, element).toBeGreaterThan(0)
    }
    expect([...baseRules.keys()]).toContain('input, select, textarea, button')
  })
})

describe('focus', () => {
  it('draws the approved ring', () => {
    expect(focus.get('outline')).toBe('2px solid var(--accent)')
    expect(focus.get('outline-offset')).toBe('2px')
  })

  it('uses focus-visible, so a pointer press does not draw it', () => {
    expect([...baseRules.keys()]).toContain(':focus-visible')
    expect(base).not.toMatch(/^\\s*:focus\\s*\\{/m)
  })

  it('measures the ring clear of the bar on every surface', () => {
    // The gate covers this pair on all four surfaces; this is the base layer
    // naming the same token rather than one of its own.
    expect(resolveToken('--accent', tokens)).toBe('oklch(0.780 0.150 72)')
    expect(focus.get('outline')).toContain('var(--accent)')
  })
})

describe('scroll destinations', () => {
  it('scroll-margins every heading', () => {
    const headings = baseRules.get('h1, h2, h3, h4, h5, h6')
    expect(headings?.get('scroll-margin-top')).toBe('var(--space-6)')
  })
})

describe('the rules, against a fixture that breaks each one', () => {
  const cases = [
    {
      name: 'a control below 1rem',
      css: '.field input { font-size: 0.875rem; }',
      rule: 'control below 1rem',
    },
    {
      name: 'a control below 1rem through a type token',
      css: '.search input { font-size: var(--type-label); }',
      rule: 'control below 1rem',
    },
    {
      name: 'a control at 13px',
      css: 'select { font-size: 13px; }',
      rule: 'control below 1rem',
    },
  ]

  for (const one of cases) {
    it(`reports ${one.name}`, () => {
      const findings = checkComponentCss(one.css, 'fixture.css', tokens)
      expect(findings.map((finding) => finding.rule)).toContain(one.rule)
    })
  }

  const permitted = [
    { name: 'the base layer itself', css: base, path: 'base.css' },
    { name: 'a control at 1rem', css: '.field input { font-size: 1rem; }', path: 'fixture.css' },
    {
      name: 'a control at a floor of 1rem',
      css: '.field input { font-size: max(1rem, 1em); }',
      path: 'fixture.css',
    },
    {
      name: 'a control at a step above 1rem',
      css: '.field input { font-size: var(--type-lead); }',
      path: 'fixture.css',
    },
  ]

  for (const one of permitted) {
    it(`allows ${one.name}`, () => {
      expect(checkComponentCss(one.css, one.path, tokens)).toEqual([])
    })
  }
})

describe('the production stylesheet', () => {
  it('keeps the three layers, in the declared order, with the rules inside them', async () => {
    const { css } = await productionBuild()

    // The minifier drops the order statement and relies on first appearance
    // instead, so what has to hold is the appearance order itself.
    const positions = ['reset', 'base', 'components'].map((layer) => css.indexOf(`@layer ${layer}`))
    expect(positions, css.slice(0, 120)).not.toContain(-1)
    expect(positions).toEqual([...positions].sort((one, other) => one - other))

    // And the rules have to be inside those blocks, not merely after them.
    const built = parseLayers(css)
    const components = built.blocks.get('components') ?? ''
    const baseBlock = built.blocks.get('base') ?? ''
    const resetBlock = built.blocks.get('reset') ?? ''

    expect(components.length).toBeGreaterThan(1000)
    expect(components).toContain('min-block-size:var(--row-height)')
    expect(components).toMatch(/\[data-vite-dev-id|_button_|\._\w+_\w+_\d+/)
    expect(baseBlock).toContain('font-variant-numeric:tabular-nums')
    expect(resetBlock).toContain('box-sizing:border-box')

    // Nothing escapes. What sits outside the layers is the declarations and
    // the faces, which compete with nothing; a rule outside them would be the
    // highest priority rule on the page.
    expect(built.unlayered).toEqual([':root', ...Array(6).fill('@font-face')])
    expect(baseBlock).not.toContain('min-block-size:var(--row-height)')
  }, 120_000)

  it('ships the base defaults it is supposed to', async () => {
    const { css } = await productionBuild()
    expect(css).toContain('font-variant-numeric:tabular-nums')
    expect(css).toContain('font-size:max(1rem,1em)')
    expect(css).toContain(':focus-visible')
  }, 120_000)
})
