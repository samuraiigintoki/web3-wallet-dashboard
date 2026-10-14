/**
 * The non-colour half of the traceability gate.
 *
 * Every custom property in the stylesheet has to be named by the direction,
 * and the direction may not name one the stylesheet leaves out. Values are
 * compared too, which is what pins the rem baseline: the document writes
 * pixels and the stylesheet must express them at 16px per rem.
 */
import { describe, expect, it } from 'vitest'

import {
  files,
  parseCssTokens,
  parseDocumentColours,
  parseDocumentScale,
  parseOklch,
  pxToRem,
  read,
  resolveToken,
} from './tokens.ts'

const css = parseCssTokens(read(files.tokens))
const scale = parseDocumentScale(read(files.direction))
const colours = parseDocumentColours(read(files.direction))

/** The document writes colours in the palette tables, not as declarations. */
const isColour = (value: string): boolean =>
  parseOklch(value) !== null || /^\d\.\d+ \d\.\d+ \d+$/.test(value)

describe('every token traces to the direction', () => {
  it('parsed a scale out of the document', () => {
    expect(scale.size).toBeGreaterThanOrEqual(30)
    expect(scale.get('--space-1')).toBe('4px')
    expect(scale.get('--type-body')).toBe('0.875rem')
    expect(scale.get('--ease-out')).toBe('cubic-bezier(0.23, 1, 0.32, 1)')
  })

  it('names no token the document does not', () => {
    // Colours arrive from the palette tables rather than as declarations, so
    // both sets count as named by the document.
    const named = new Set([...scale.keys(), ...colours.keys()])
    const invented = [...css.keys()].filter((name) => !named.has(name))
    expect(invented).toEqual([])
  })

  it('leaves out no token the document names', () => {
    const named = [...scale.keys(), ...colours.keys()]
    const missing = named.filter((name) => !css.has(name))
    expect(missing).toEqual([])
  })

  it('gives each token the document value', () => {
    const wrong: string[] = []

    for (const [name, declared] of scale) {
      const written = css.get(name)
      if (written === undefined || isColour(declared)) {
        continue
      }

      const resolved = resolveToken(name, css) ?? ''
      // Sizes the document writes in pixels convert at 16px per rem; --radius-pill
      // is written as 999px on purpose and stays as it is.
      const expected =
        Number.parseInt(declared, 10) >= 100 ? declared : (pxToRem(declared) ?? declared)
      if (resolved.trim() !== expected) {
        wrong.push(`${name}: ${resolved.trim()} in the stylesheet, ${expected} in the document`)
      }
    }

    expect(wrong).toEqual([])
  })

  it('expresses every small pixel size in rem, at 16px per rem', () => {
    const offenders: string[] = []

    for (const [name, declared] of scale) {
      const rem = pxToRem(declared)
      if (rem === null || Number.parseInt(declared, 10) >= 100) {
        // --radius-pill is 999px in the direction and stays 999px.
        continue
      }
      if (css.get(name) !== rem) {
        offenders.push(`${name}: ${String(css.get(name))}, expected ${rem}`)
      }
    }

    expect(offenders).toEqual([])
    expect(css.get('--radius-pill')).toBe('999px')
  })
})
