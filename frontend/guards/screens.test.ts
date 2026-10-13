/**
 * The screens: the display preset, the frame's two shapes, and the auth
 * composition.
 *
 * Three things are checked here that a reviewer cannot see in a diff.
 *
 * The display face is set at two steps with its axes pinned, and every rule
 * that sets it has to carry the pin. A third display rule without it would
 * render, look plausible, and quietly break both the approved shape and the
 * fallback correction that was measured against it.
 *
 * The frame is one list of destinations in two shapes. The labels, the routes
 * behind them and the clearance a fixed strip needs are checked as facts, not
 * as intentions.
 *
 * The auth facts are the four recorded ones, in the recorded words, and they
 * come after the form. That order is the composition, so it is asserted rather
 * than left to the next edit.
 */
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

import { AUTH_FACTS } from '../src/ui/authFacts.ts'
import { files, filesUnder, minimumRem, parseCssTokens, read, resolveToken } from './tokens.ts'

type Block = { path: string; selector: string; body: string }

/**
 * Every leaf block in a stylesheet, nested at-rules included.
 *
 * The shared parser reads a nested at-rule as one block and loses the rule
 * inside it, which is fine for the rules that only look at declarations but
 * useless here: a display rule inside a media query would go unseen. This
 * walks the braces instead.
 */
function leafBlocks(path: string): Block[] {
  const source = read(path).replace(/\/\*[\s\S]*?\*\//g, '')
  const found: Block[] = []
  const open: { selector: string; bodyStart: number }[] = []
  let selectorStart = 0

  for (let index = 0; index < source.length; index += 1) {
    const char = source[index]

    if (char === '{') {
      open.push({ selector: source.slice(selectorStart, index).trim(), bodyStart: index + 1 })
      selectorStart = index + 1
    } else if (char === '}') {
      const block = open.pop()
      if (block !== undefined && !block.selector.startsWith('@')) {
        found.push({ path, selector: block.selector, body: source.slice(block.bodyStart, index) })
      }
      selectorStart = index + 1
    }
  }

  return found
}

/** Every block in every stylesheet, keyed by path and selector. */
const stylesheets = filesUnder(files.src, (name) => name.endsWith('.css'))
const allBlocks = stylesheets.flatMap((path) => leafBlocks(path))

const relative = (path: string): string => path.slice(files.src.length + 1)
const findBlock = (file: string, selector: string): Block => {
  const found = allBlocks.find(
    (block) => relative(block.path) === file && block.selector === selector,
  )
  if (found === undefined) {
    throw new Error(`${file} declares no ${selector} rule`)
  }
  return found
}

const raw = (file: string): string => read(resolve(files.src, file))

const direction = read(files.direction)
const brief = read(resolve(files.direction, '..', 'experience-brief.md'))

const displayBlocks = allBlocks.filter((block) =>
  block.body.includes('font-family: var(--font-display)'),
)

const PIN = "font-variation-settings: 'opsz' 144, 'SOFT' 40, 'WONK' 1"

describe('the display preset', () => {
  it('is set in exactly two rules, each named here', () => {
    expect(
      displayBlocks.map((block) => `${relative(block.path)}: ${block.selector}`).sort(),
    ).toEqual(['ui/AuthComposition.module.css: .headline', 'ui/Page.module.css: .page h1'])
  })

  it('carries the family and the axis pin together, everywhere it is set', () => {
    for (const block of displayBlocks) {
      expect(block.body, `${block.path} ${block.selector}`).toContain('font-optical-sizing: none')
      expect(block.body, `${block.path} ${block.selector}`).toContain(PIN)
    }
  })

  it('never asks the display face for tabular figures, which it does not have', () => {
    // Fraunces carries proportional digits and no `tnum` feature. A figure set
    // in it would be a figure the layout cannot align, so the display face is
    // never asked and the role is left to Archivo or to the mono.
    for (const sheet of stylesheets) {
      expect(read(sheet), relative(sheet)).not.toContain('tnum')
    }

    for (const block of displayBlocks) {
      expect(block.body, `${block.path} ${block.selector}`).not.toContain('font-variant-numeric')
    }
  })

  it('stays at the two steps it was measured at', () => {
    // A third step is a rendering decision, not a new declaration: the numbers
    // in the document were measured at 40px and 28px.
    const sizes = displayBlocks.map((block) => /font-size:\s*([^;]+);/.exec(block.body)?.[1] ?? '')
    expect(sizes.sort()).toEqual(['var(--type-headline)', 'var(--type-page)'])
  })
})

describe('what the document says about the preset', () => {
  it('records the pinned values and the rule that they travel with the family', () => {
    expect(direction).toContain(PIN)
    expect(direction).toContain('font-optical-sizing: none')
    expect(direction).toContain('sets the family and the pin together')
  })

  it('records that the display face has no tabular figures', () => {
    expect(direction).toMatch(/proportional digits/)
    expect(direction).toContain('tnum')
  })
})

describe('the recorded fallback values', () => {
  const fallbacks = [
    { family: 'Fraunces Fallback', sizeAdjust: '95.50%', ascent: '102.62%', descent: '27.23%' },
    { family: 'Archivo Fallback', sizeAdjust: '99.40%', ascent: '88.53%', descent: '21.13%' },
    {
      family: 'Martian Mono Fallback',
      sizeAdjust: '112.00%',
      ascent: '89.29%',
      descent: '17.86%',
    },
  ] as const

  it('are declared on the fallback face, with the values the direction records', () => {
    const fontsCss = raw('styles/fonts.css')

    for (const fallback of fallbacks) {
      const start = fontsCss.indexOf(`font-family: '${fallback.family}'`)
      expect(start, fallback.family).toBeGreaterThan(-1)
      const body = fontsCss.slice(start, fontsCss.indexOf('}', start))

      expect(body, fallback.family).toContain(`size-adjust: ${fallback.sizeAdjust}`)
      expect(body, fallback.family).toContain(`ascent-override: ${fallback.ascent}`)
      expect(body, fallback.family).toContain(`descent-override: ${fallback.descent}`)
      expect(body, fallback.family).toContain('line-gap-override: 0%')
    }
  })

  it('are the same values in the direction document', () => {
    for (const fallback of fallbacks) {
      expect(direction, fallback.family).toContain(fallback.sizeAdjust)
      expect(direction, fallback.family).toContain(fallback.ascent)
      expect(direction, fallback.family).toContain(fallback.descent)
    }
  })

  it('are bounded in the document to the local faces they were measured on', () => {
    expect(direction).toMatch(/calibrated to the local faces/)
    expect(direction).toMatch(/not a claim about every platform/)
  })
})

describe('the frame', () => {
  const layout = read(resolve(files.src, 'pages/ShellLayout.tsx'))
  const shell = read(resolve(files.src, 'ui/Shell.tsx'))
  const app = read(resolve(files.src, 'App.tsx'))

  it('lists the three destinations this block ships, in order, by label', () => {
    const labels = [...layout.matchAll(/label: '([^']+)'/g)].map((match) => match[1] ?? '')
    const paths = [...layout.matchAll(/to: '([^']+)'/g)].map((match) => match[1] ?? '')

    expect(labels).toEqual(['Overview', 'Contracts', 'Wallets'])
    expect(paths).toEqual(['/', '/contracts', '/wallets'])
  })

  it('offers nothing that leads nowhere: every destination is a route', () => {
    const paths = [...layout.matchAll(/to: '([^']+)'/g)].map((match) => match[1] ?? '')
    const routes = [...app.matchAll(/path="([^"]+)"/g)].map((match) => match[1] ?? '')

    for (const path of paths) {
      if (path === '/') {
        expect(app).toContain('<Route index element={')
        continue
      }
      expect(routes, path).toContain(path.slice(1))
    }
  })

  it('renders the label as the link text, so no destination is an icon alone', () => {
    expect(shell).toContain('{destination.label}')
    expect(shell).not.toMatch(/<svg|<img/)
  })

  it('is a strip fixed to the bottom below 48rem, with the safe area added', () => {
    const nav = findBlock('ui/Shell.module.css', '.nav')
    expect(nav.body).toContain('position: fixed')
    expect(nav.body).toContain('inset-block-end: 0')
    expect(nav.body).toContain('padding-block-end: env(safe-area-inset-bottom)')

    const list = findBlock('ui/Shell.module.css', '.list')
    expect(list.body).toContain('env(safe-area-inset-left)')
    expect(list.body).toContain('env(safe-area-inset-right)')
  })

  it('becomes a static rail at 48rem, and the frame stops reserving the strip', () => {
    const css = raw('ui/Shell.module.css')
    const start = css.indexOf('@media (min-width: 48rem)')
    expect(start).toBeGreaterThan(-1)
    const wide = css.slice(start)

    expect(wide).toContain('grid-template-columns: 13rem minmax(0, 1fr)')
    expect(wide).toMatch(/\.nav\s*\{[^}]*position: static/)
    expect(wide).toMatch(/\.shell\s*\{[^}]*padding-block-end: 0/)
  })

  it('keeps the frame and the root scroller clear of the strip', () => {
    const shellBlock = findBlock('ui/Shell.module.css', '.shell')
    expect(shellBlock.body).toContain('padding-block-end: calc(')
    expect(shellBlock.body).toContain('env(safe-area-inset-bottom)')

    const base = read(resolve(files.src, 'styles/base.css'))
    const html = findBlock('styles/base.css', 'html')
    expect(html.body).toContain('scroll-padding-block-end: calc(')
    expect(html.body).toContain('env(safe-area-inset-bottom)')
    expect(base).toContain('a control the thumb owns')
  })

  it('gives every destination the row height, in both shapes', () => {
    const link = findBlock('ui/Shell.module.css', '.link')
    expect(link.body).toContain('min-block-size: var(--row-height)')
  })

  it('keeps the whole focus ring inside the viewport at every edge', () => {
    // The ring is drawn outside the element: 2px outline plus 2px offset. A
    // link flush with an edge has part of it off screen, which is what the
    // padding on each list is for.
    const ring = 4
    const strip = findBlock('ui/Shell.module.css', '.list')
    expect(strip.body).toContain('padding-block: var(--space-2)')
    expect(strip.body).toMatch(/padding-inline:\s*max\(env\(safe-area-inset-left\),\s*var\(--space-3\)\)/)

    const css = raw('ui/Shell.module.css')
    const wide = css.slice(css.indexOf('@media (min-width: 48rem)'))
    const railList = /\.list\s*\{([^}]*)\}/.exec(wide)?.[1] ?? ''
    expect(railList).toContain('padding-inline: var(--gutter-page)')
    expect(railList).toContain('padding-block: 0')
    // The rail's own block padding covers the first and last destination.
    const railNav = /\.nav\s*\{([^}]*)\}/.exec(wide)?.[1] ?? ''
    expect(railNav).toContain('padding-block: var(--space-3)')

    const tokens = parseCssTokens(read(files.tokens))
    const px = (name: string): number => {
      const value = resolveToken(name, tokens)
      const rem = value === null ? null : minimumRem(value, tokens)
      if (rem === null) {
        throw new Error(`${name} does not resolve to a length`)
      }
      return rem * 16
    }

    for (const [name, value] of [
      ['--space-2', px('--space-2')],
      ['--space-3', px('--space-3')],
      ['--gutter-page', px('--gutter-page')],
    ] as const) {
      expect(value, name).toBeGreaterThanOrEqual(ring)
    }
  })

  it("reserves more than the strip's height, so no control is covered", () => {
    const tokens = parseCssTokens(read(files.tokens))
    const px = (name: string): number => {
      const value = resolveToken(name, tokens)
      const rem = value === null ? null : minimumRem(value, tokens)
      if (rem === null) {
        throw new Error(`${name} does not resolve to a length`)
      }
      return rem * 16
    }

    const stripHeight = px('--row-height') + 2 * px('--space-2')
    const reserve = px('--row-height') + 2 * px('--space-2') + px('--space-4')

    expect(reserve).toBeGreaterThan(stripHeight)

    // The frame and the root scroller state the same reserve.
    expect(findBlock('ui/Shell.module.css', '.shell').body).toContain(
      'var(--row-height) + var(--space-2) * 2 + var(--space-4) + env(safe-area-inset-bottom)',
    )
    expect(findBlock('styles/base.css', 'html').body).toContain(
      'var(--row-height) + var(--space-2) * 2 + var(--space-4) + env(safe-area-inset-bottom)',
    )
  })

  it('marks the open destination by shape as well as by ink', () => {
    const tick = findBlock('ui/Shell.module.css', '.link::before')
    expect(tick.body).toContain('background: var(--line)')

    const open = findBlock('ui/Shell.module.css', ".link[aria-current='page']::before")
    expect(open.body).toContain('background: var(--line-strong)')
    expect(open.body).toMatch(/inline-size: 2rem/)
  })
})

describe('the auth composition', () => {
  const composition = read(resolve(files.src, 'ui/AuthComposition.tsx'))
  const login = read(resolve(files.src, 'pages/LoginPage.tsx'))
  const register = read(resolve(files.src, 'pages/RegisterPage.tsx'))

  it('carries the four recorded facts, in order, in the words they were agreed in', () => {
    expect(AUTH_FACTS).toHaveLength(4)
    for (const fact of AUTH_FACTS) {
      expect(brief, fact).toContain(fact)
    }
  })

  it('renders them as a list under a real heading, not as decoration', () => {
    expect(composition).toContain('aria-labelledby="facts-heading"')
    expect(composition).toContain('<h2')
    expect(composition).toContain('{AUTH_FACTS.map(')
  })

  it('puts the form before the facts in the document', () => {
    // The facts are after the children, and the children are the form. This is
    // the composition: nothing has to be read or dismissed before the form.
    const column = composition.indexOf('styles.column')
    const facts = composition.indexOf('styles.facts')
    expect(column).toBeGreaterThan(-1)
    expect(facts).toBeGreaterThan(column)
    expect(composition).toContain('{children}')

    for (const page of [login, register]) {
      const form = page.indexOf('<PageForm')
      expect(form).toBeGreaterThan(-1)
    }
  })

  it('is the only place with the headline step, and both auth screens use it', () => {
    for (const page of [login, register]) {
      expect(page).toContain('<AuthComposition')
      expect(page).not.toContain('<Page ')
    }

    const headlineBlock = findBlock('ui/AuthComposition.module.css', '.headline')
    expect(headlineBlock.body).toContain('font-size: var(--type-headline)')
  })

  it('keeps the password hint on register and off sign in', () => {
    expect(register).toContain('PASSWORD_HINT')
    expect(login).not.toContain('PASSWORD_HINT')
    expect(login).not.toMatch(/15 characters/)
  })
})

describe('the states', () => {
  it('gives the restoring screen one anatomy, used by both guards', () => {
    const restoring = read(resolve(files.src, 'pages/RestoringScreen.tsx'))
    expect(restoring).toContain('<Skeleton status="Restoring your session."')

    for (const guard of ['routes/RequireAuth.tsx', 'routes/GuestOnly.tsx']) {
      expect(read(resolve(files.src, guard)), guard).toContain('<RestoringScreen />')
    }

    // The auth guard used to render a bare main of its own, which was a second
    // anatomy and unstyled.
    expect(read(resolve(files.src, 'routes/GuestOnly.tsx'))).not.toContain('aria-busy="true"')
  })

  it('shows the restoring status in words once the wait runs long', () => {
    const restoring = read(resolve(files.src, 'pages/RestoringScreen.tsx'))
    expect(restoring).toContain('statusVisible={showStatus}')
    expect(restoring).toMatch(/setTimeout\(/)
    expect(restoring).toContain('clearTimeout(timer)')

    const skeleton = read(resolve(files.src, 'ui/Skeleton.tsx'))
    expect(skeleton).toContain('statusVisible ? styles.status : styles.srOnly')

    // One live region, and the visible line is the same sentence rather than a
    // second one.
    const skeletonCss = raw('ui/Skeleton.module.css')
    expect(skeletonCss).toContain('.status {')
    expect(skeletonCss).toContain('.srOnly {')
  })

  it('keeps both ways forward on the unavailable screen, and says what each does', () => {
    const unavailable = read(resolve(files.src, 'routes/RequireAuth.tsx'))
    expect(unavailable).toContain('onClick={retryRestore}')
    expect(unavailable).toContain('onClick={signOutLocally}')
    // The failed check, the retained token and the unknown answer, with no
    // claim the copy cannot support.
    expect(unavailable).toContain('could not reach the API to check your session')
    expect(unavailable).toContain('still stored on this device')
    expect(unavailable).toMatch(/still accepts that token is unknown/)
    expect(unavailable).not.toContain('nothing has been lost')
    expect(unavailable).not.toMatch(/changes nothing/)
  })

  it('keeps the not-found recovery link to the overview', () => {
    const placeholders = read(resolve(files.src, 'pages/placeholders.tsx'))
    expect(placeholders).toContain('<Link to="/">Go to the overview</Link>')
    expect(placeholders).toContain('Page not found')
  })

  it('still invents nothing in a placeholder', () => {
    const placeholders = read(resolve(files.src, 'pages/placeholders.tsx'))
    // No figure, no count, no illustrative row: the ban is stated where the
    // screens are written and the text carries no number at all.
    expect(placeholders).toContain('No illustrative row, count or')
    expect(placeholders).not.toMatch(/\d{3,}/)
    expect(placeholders).not.toMatch(/\b\d+ (?:wallets?|contracts?|events?)\b/)
  })
})
