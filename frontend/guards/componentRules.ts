import { minimumRem, MINIMUM_CONTROL_REM, parseDeclarations } from './tokens.ts'
import type { TokenMap } from './tokens.ts'

/**
 * The rules that apply to component stylesheets.
 *
 * The tree carries no component CSS yet, so these find nothing today. They are
 * written now, and exercised against fixture sources in the test, so that the
 * first component to break one of them fails rather than passes unnoticed.
 */

export type Finding = { path: string; rule: string; detail: string }

const CONTROLS = /\b(?:input|select|textarea|button)\b|\[type=|\[role=/i
const TINTS = '--tint-|--accent-soft'
const ABOVE_BODY = [
  '--type-body',
  '--type-lead',
  '--type-section',
  '--type-panel',
  '--type-page',
  '--type-headline',
]

export function checkComponentCss(
  source: string,
  path: string,
  tokens: TokenMap = new Map(),
): Finding[] {
  const findings: Finding[] = []
  const withoutComments = source.replace(/\/\*[\s\S]*?\*\//g, '')

  for (const match of withoutComments.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selector = match[1]?.trim() ?? ''
    const declared = parseDeclarations(match[2] ?? '')
    const colour = declared.get('color') ?? ''
    const size = declared.get('font-size') ?? ''

    // --text-3 starts at 14px. Below that the reading bar applies and only
    // --text-1 or --text-2 may carry the text. Only the `color` property
    // counts: a border painted with a text token is not a foreground.
    if (/var\(--text-3\)/.test(colour) && size !== '') {
      const large = ABOVE_BODY.some((token) => size.includes(token))
      if (!large) {
        findings.push({
          path,
          rule: 'text-3 below 14px',
          detail: `${selector} sets --text-3 at ${size}`,
        })
      }
    }

    // Text on a tint is --text-1 in every case, and again only `color` is the
    // label: a tint background with --text-2 as `color` is the rule broken.
    const background = declared.get('background') ?? declared.get('background-color') ?? ''
    if (new RegExp(`var\\((${TINTS})`).test(background) && !/var\(--text-1\)/.test(colour)) {
      findings.push({
        path,
        rule: 'text on a tint',
        detail: `${selector} paints a tint without --text-1 for the label`,
      })
    }

    // A control is never smaller than 1rem: below that a browser zooms the
    // page on focus on a phone, and the target is too small to hit.
    if (CONTROLS.test(selector) && size !== '') {
      const floor = minimumRem(size, tokens)
      if (floor !== null && floor < MINIMUM_CONTROL_REM) {
        findings.push({
          path,
          rule: 'control below 1rem',
          detail: `${selector} sets a control to ${size}`,
        })
      }
    }

    // A control boundary is --line-control. --line and --line-strong are
    // structure and fall short of the 3:1 and Lc 30 a boundary needs.
    if (CONTROLS.test(selector)) {
      for (const [property, value] of declared) {
        if (!property.startsWith('border')) {
          continue
        }
        if (value.includes('var(--line)') || value.includes('var(--line-strong)')) {
          findings.push({
            path,
            rule: 'control boundary',
            detail: `${selector} bounds a control with --line or --line-strong`,
          })
        }
      }
    }
  }

  return findings
}
