/**
 * The component rules, run against the tree and against fixtures.
 *
 * The tree has no component stylesheet yet. The fixtures below are what makes
 * these tests worth having before it does: each one is a rule being broken, so
 * a rule that stopped working would fail here.
 */
import { describe, expect, it } from 'vitest'

import { checkComponentCss } from './componentRules.ts'
import { files, filesUnder, parseCssTokens, read } from './tokens.ts'

const tokens = parseCssTokens(read(files.tokens))

const componentCss = filesUnder(files.src, (name) => name.endsWith('.css')).filter(
  (path) => !path.endsWith('tokens.css') && !path.endsWith('styles.css'),
)

describe('the tree', () => {
  it('finds no component stylesheet breaking a rule', () => {
    const findings = componentCss.flatMap((path) => checkComponentCss(read(path), path, tokens))
    expect(findings.map((finding) => `${finding.path}: ${finding.rule} (${finding.detail})`)).toEqual([])
  })
})

describe('the rules, against a fixture that breaks each one', () => {
  const cases = [
    {
      name: '--text-3 under 14px',
      css: '.meta { font-size: var(--type-meta); color: var(--text-3); }',
      rule: 'text-3 below 14px',
    },
    {
      name: 'a tint behind something other than --text-1',
      css: '.row-selected { background: var(--accent-soft); color: var(--text-2); }',
      rule: 'text on a tint',
    },
    {
      // A border painted with a text token is not a foreground. This one has
      // --text-1 on the border and --text-2 where the label actually is.
      name: 'a tint whose border colour hides the wrong foreground',
      css: '.chip { background: var(--accent-soft); border-color: var(--text-1); color: var(--text-2); }',
      rule: 'text on a tint',
    },
    {
      name: 'a control bounded by a decorative line',
      css: '.field input { border: 1px solid var(--line); }',
      rule: 'control boundary',
    },
  ]

  for (const one of cases) {
    it(`reports ${one.name}`, () => {
      const findings = checkComponentCss(one.css, 'fixture.css', tokens)
      expect(findings.map((finding) => finding.rule)).toContain(one.rule)
    })
  }

  const permitted = [
    {
      name: '--text-3 at 14px and above',
      css: '.label { font-size: var(--type-body); color: var(--text-3); }',
    },
    {
      name: '--text-3 at a heading size',
      css: '.summary { font-size: var(--type-section); color: var(--text-3); }',
    },
    {
      name: '--text-1 on a tint',
      css: '.row-selected { background: var(--accent-soft); color: var(--text-1); }',
    },
    {
      name: 'a control bounded by --line-control',
      css: '.field input { border: 1px solid var(--line-control); }',
    },
    {
      name: 'a control at the base floor',
      css: '.field input { font-size: max(1rem, 1em); }',
    },
    {
      // A border is not a foreground, so this is not a below-size text rule.
      name: 'a border colour of --text-3 with no foreground set',
      css: '.badge { font-size: var(--type-meta); border-color: var(--text-3); }',
    },
    {
      name: 'a border colour of --text-3 alongside a real 12px foreground',
      css: '.badge { font-size: var(--type-meta); color: var(--text-2); border-color: var(--text-3); }',
    },
  ]

  for (const one of permitted) {
    it(`allows ${one.name}`, () => {
      expect(checkComponentCss(one.css, 'fixture.css', tokens)).toEqual([])
    })
  }
})
