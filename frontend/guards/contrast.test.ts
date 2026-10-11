/**
 * The contrast gate.
 *
 * Every pair is measured from the stylesheet against the thresholds recorded
 * in docs/design/direction.md, on both scales, and the stricter wins. The
 * pairs are declared here rather than discovered, and a semantic text token
 * that appears in no pair fails, so a token cannot be added and quietly left
 * ungated.
 */
import { describe, expect, it } from 'vitest'

import { apcaLc, fromOklch, wcagRatio } from './colour.ts'
import { files, parseCssTokens, parseGateRoles, read, resolveToken } from './tokens.ts'
import type Color from 'colorjs.io'

const css = parseCssTokens(read(files.tokens))
const roles = parseGateRoles(read(files.direction))

const surfaces = ['--bg-0', '--bg-1', '--bg-2', '--bg-3'] as const
const tints = [
  '--accent-soft',
  '--tint-executed',
  '--tint-revoked',
  '--tint-vanished',
  '--tint-error',
] as const

const stateTints = {
  '--state-executed': '--tint-executed',
  '--state-revoked': '--tint-revoked',
  '--state-vanished': '--tint-vanished',
  '--state-error': '--tint-error',
  '--state-awaiting': '--accent-soft',
} as const

type Pair = { name: string; text: string; background: string; role: string }

const pairs: Pair[] = [
  // Reading text, both measures, on every surface it can land on.
  ...surfaces.flatMap((surface): Pair[] => [
    { name: `--text-1 on ${surface}`, text: '--text-1', background: surface, role: 'Reading text' },
    { name: `--text-2 on ${surface}`, text: '--text-2', background: surface, role: 'Reading text' },
  ]),
  // Text on a tint is --text-1, in every case.
  ...tints.map((tint): Pair => ({
    name: `--text-1 on ${tint}`,
    text: '--text-1',
    background: tint,
    role: 'Reading text',
  })),
  // Supporting text, 14px and above.
  ...surfaces.map((surface): Pair => ({
    name: `--text-3 on ${surface}`,
    text: '--text-3',
    background: surface,
    role: 'Supporting text',
  })),
  // A label on the accent fill.
  { name: '--accent-ink on --accent', text: '--accent-ink', background: '--accent', role: 'Supporting text' },
  { name: '--accent-ink on --accent-hover', text: '--accent-ink', background: '--accent-hover', role: 'Supporting text' },
  // Headings.
  ...surfaces.map((surface): Pair => ({
    name: `--text-1 heading on ${surface}`,
    text: '--text-1',
    background: surface,
    role: 'Headings',
  })),
  // Non-text: control boundaries and the focus ring.
  ...surfaces.map((surface): Pair => ({
    name: `--line-control on ${surface}`,
    text: '--line-control',
    background: surface,
    role: 'Non-text boundary, focus indicator',
  })),
  { name: '--accent focus ring on --bg-1', text: '--accent', background: '--bg-1', role: 'Non-text boundary, focus indicator' },
  // A state hue against its own tint, where the hue goes on the border.
  ...Object.entries(stateTints).map(([state, tint]): Pair => ({
    name: `${state} on ${tint}`,
    text: state,
    background: tint,
    role: 'Non-text boundary, focus indicator',
  })),
  // Disabled text, which is never informative.
  ...surfaces.map((surface): Pair => ({
    name: `--text-disabled on ${surface}`,
    text: '--text-disabled',
    background: surface,
    role: 'Disabled text',
  })),
]

function colourOf(token: string): Color {
  const resolved = resolveToken(token, css)
  if (resolved === null) {
    throw new Error(`${token} is not declared in the stylesheet`)
  }

  return fromOklch(resolved)
}

function measure(pair: Pair): { lc: number; wcag: number } {
  const text = colourOf(pair.text)
  const background = colourOf(pair.background)

  return { lc: apcaLc(text, background), wcag: wcagRatio(text, background) }
}

describe('the gate roles', () => {
  it('parsed the thresholds out of the document', () => {
    // A parser that matched nothing would make the rest of this file vacuous.
    expect(roles.size).toBe(5)
    expect(roles.get('Reading text')).toEqual({ lc: 75, wcag: 4.5 })
    expect(roles.get('Supporting text')).toEqual({ lc: 60, wcag: 4.5 })
    expect(roles.get('Headings')).toEqual({ lc: 45, wcag: 3 })
    expect(roles.get('Non-text boundary, focus indicator')).toEqual({ lc: 30, wcag: 3 })
    expect(roles.get('Disabled text')).toEqual({ lc: 15, wcag: null })
  })

  it('declares a role for every pair it measures', () => {
    const unknown = pairs.filter((pair) => !roles.has(pair.role))
    expect(unknown.map((pair) => `${pair.name} (${pair.role})`)).toEqual([])
  })
})

describe('every declared pair clears its role on both measures', () => {
  it('clears APCA and WCAG', () => {
    const failures: string[] = []

    for (const pair of pairs) {
      const threshold = roles.get(pair.role)
      if (threshold === undefined) {
        failures.push(`${pair.name}: no threshold for ${pair.role}`)
        continue
      }

      const { lc, wcag } = measure(pair)
      if (Math.abs(lc) < threshold.lc) {
        failures.push(`${pair.name}: Lc ${Math.abs(lc).toFixed(1)}, ${pair.role} needs ${String(threshold.lc)}`)
      }
      if (threshold.wcag !== null && wcag < threshold.wcag) {
        failures.push(`${pair.name}: ${wcag.toFixed(2)}:1, ${pair.role} needs ${String(threshold.wcag)}:1`)
      }
    }

    expect(failures).toEqual([])
  })

  it('covers every semantic text token', () => {
    const textTokens = [...css.keys()].filter(
      (name) => name.startsWith('--text-') || name === '--accent-ink',
    )
    expect(textTokens.length).toBeGreaterThan(0)

    for (const token of textTokens) {
      const used = pairs.some((pair) => pair.text === token || pair.background === token)
      expect(used, `${token} appears in no pair`).toBe(true)
    }
  })

  it('covers the four surfaces and the five tints', () => {
    for (const surface of [...surfaces, ...tints]) {
      const used = pairs.some((pair) => pair.background === surface)
      expect(used, `${surface} is measured in no pair`).toBe(true)
    }
  })
})

describe('the gate rejects what it should', () => {
  it('would catch a control bounded by a decorative line', () => {
    // --line and --line-strong are structure, not boundaries. This is the
    // negative control for the rule above.
    for (const line of ['--line', '--line-strong']) {
      for (const surface of surfaces) {
        const { lc, wcag } = measure({ name: line, text: line, background: surface, role: 'Non-text boundary, focus indicator' })
        expect(Math.abs(lc), `${line} on ${surface} Lc`).toBeLessThan(30)
        expect(wcag, `${line} on ${surface}`).toBeLessThan(3)
      }
    }
  })

  it('shows --text-2 with no margin on a tint, which is why text on a tint is --text-1', () => {
    // Measured: 74.53, 74.88, 74.93, 75.03, 75.04. Two of the five clear the
    // bar by three hundredths, so the rule cannot rest on text-2 being under
    // it; it rests on there being no margin worth relying on.
    const readings = tints.map((tint) =>
      Math.abs(measure({ name: tint, text: '--text-2', background: tint, role: 'Reading text' }).lc),
    )

    expect(Math.max(...readings)).toBeLessThan(75.2)
    expect(Math.min(...readings)).toBeLessThan(75)
  })

  it('would catch a label on the accent at the reading threshold', () => {
    for (const fill of ['--accent', '--accent-hover']) {
      const { lc } = measure({ name: fill, text: '--accent-ink', background: fill, role: 'Reading text' })
      expect(Math.abs(lc), `--accent-ink on ${fill} Lc`).toBeLessThan(75)
    }
  })
})

describe('the sizes the tokens allow', () => {
  const meta = css.get('--type-meta') ?? ''
  const label = css.get('--type-label') ?? ''
  const body = css.get('--type-body') ?? ''

  it('keeps 12px and 13px below the size --text-3 starts at', () => {
    expect(meta).toBe('0.75rem')
    expect(label).toBe('0.8125rem')
    expect(body).toBe('0.875rem')
  })

  it('declares the small sizes against --text-1 and --text-2 only', () => {
    const small: Pair[] = [
      { name: '--text-1 at 12px', text: '--text-1', background: '--bg-1', role: 'Reading text' },
      { name: '--text-2 at 12px', text: '--text-2', background: '--bg-1', role: 'Reading text' },
      { name: '--text-1 at 13px', text: '--text-1', background: '--bg-1', role: 'Reading text' },
      { name: '--text-2 at 13px', text: '--text-2', background: '--bg-1', role: 'Reading text' },
    ]

    for (const pair of small) {
      expect(pairs.some((declared) => declared.name === pair.name), pair.name).toBe(false)
      const { lc } = measure(pair)
      expect(Math.abs(lc), pair.name).toBeGreaterThanOrEqual(75)
    }
  })
})

describe('known answers', () => {
  it('measures accent on the ground, with the sign APCA defines', () => {
    // APCA is polarity sensitive, so the sign is part of the answer. The
    // accent is lighter than the ground, which is reverse polarity, so the
    // figure is negative; swapped, it is positive and slightly larger.
    const accent = colourOf('--accent')
    const ground = colourOf('--bg-0')

    expect(apcaLc(accent, ground)).toBeCloseTo(-62.4, 1)
    expect(apcaLc(ground, accent)).toBeCloseTo(63.9, 1)
  })

  it('measures a known WCAG pair', () => {
    expect(wcagRatio(colourOf('--text-1'), colourOf('--bg-0'))).toBeCloseTo(16.9, 1)
  })
})

describe('the printed table', () => {
  it('prints every pair, for the record', () => {
    const rows = pairs.map((pair) => {
      const { lc, wcag } = measure(pair)
      const threshold = roles.get(pair.role)
      return (
        pair.name.padEnd(38) +
        pair.role.padEnd(36) +
        `Lc ${Math.abs(lc).toFixed(1).padStart(5)} / ${String(threshold?.lc ?? 0).padStart(3)}` +
        `  ${wcag.toFixed(2).padStart(6)}:1 / ${threshold?.wcag === null ? 'n/a' : String(threshold?.wcag)}`
      )
    })

    console.log(`\ncontrast table, ${String(pairs.length)} pairs\n` + rows.join('\n'))
    expect(rows).toHaveLength(pairs.length)
  })
})
