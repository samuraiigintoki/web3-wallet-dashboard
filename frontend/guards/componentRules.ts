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

export function checkComponentCss(source: string, path: string): Finding[] {
  const findings: Finding[] = []
  const withoutComments = source.replace(/\/\*[\s\S]*?\*\//g, '')

  for (const match of withoutComments.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selector = match[1]?.trim() ?? ''
    const declarations = match[2] ?? ''

    // --text-3 starts at 14px. Below that the reading bar applies and only
    // --text-1 or --text-2 may carry the text.
    if (/color:\s*var\(--text-3\)/.test(declarations)) {
      const size = /font-size:\s*([^;]+)/.exec(declarations)?.[1]?.trim() ?? ''
      const allowed = ABOVE_BODY.some((token) => size.includes(token)) || size === ''
      if (!allowed) {
        findings.push({
          path,
          rule: 'text-3 below 14px',
          detail: `${selector} sets --text-3 at ${size === '' ? 'an unstated size' : size}`,
        })
      }
    }

    // Text on a tint is --text-1 in every case.
    if (new RegExp(`background(?:-color)?:\\s*var\\((${TINTS})`).test(declarations)) {
      if (!/color:\s*var\(--text-1\)/.test(declarations)) {
        findings.push({
          path,
          rule: 'text on a tint',
          detail: `${selector} paints a tint without --text-1 for the label`,
        })
      }
    }

    // A control boundary is --line-control. --line and --line-strong are
    // structure and fall short of the 3:1 and Lc 30 a boundary needs.
    if (CONTROLS.test(selector) && /\bborder(?:-[a-z]+)?:\s*[^;]*var\(--line(-strong)?\)/.test(declarations)) {
      findings.push({
        path,
        rule: 'control boundary',
        detail: `${selector} bounds a control with --line or --line-strong`,
      })
    }
  }

  return findings
}
