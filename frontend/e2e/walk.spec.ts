/**
 * The browser walks: rendered evidence as a CI job.
 *
 * Every walk runs against the production build served by `vite preview`, with
 * the fixture API on 8099 behind the dev proxy. The data is labelled fixture
 * data: one route, one identity, no chain, no wallet, no transaction. What is
 * measured here is geometry and paint, the two things a source guard cannot
 * see: the ring box against the viewport, the accent painted where the ring
 * should be, the reserve holding a scrolled control clear of the strip, the
 * reachability of all four auth facts on both auth routes at a zero and at a
 * positive bottom inset, the complete static read for a reduced-motion
 * reader, and the frame intervals while a fact is actually settling, under a
 * throttled profile, as a labelled coarse alarm under the recorded 60fps
 * requirement.
 *
 * Recordings are evidence of order and visibility. They replace neither the
 * frame measurement below nor any live-API behaviour.
 */
import { execFileSync } from 'node:child_process'

import { expect, test, type BrowserContext, type Page, type TestInfo } from '@playwright/test'

import { decodePng } from './png.ts'

const SESSION_KEY = 'web3-wallet-dashboard.session-token'
const SESSION_TOKEN = 'fixture-session-token'
const ACCENT: readonly [number, number, number] = [242, 166, 53]
const TOLERANCE = 10
const RING = 4

type Ring = { left: number; top: number; right: number; bottom: number }

/**
 * Seed the fixture session before navigation. Only the shell walks get it:
 * the auth walks must reach /login as a guest, and GuestOnly sends an
 * authenticated reader away from it.
 */
async function seedSession(context: BrowserContext): Promise<void> {
  await context.addInitScript(
    ({ key, token }) => window.localStorage.setItem(key, token),
    { key: SESSION_KEY, token: SESSION_TOKEN },
  )
}

/** Tab presses until the named control holds focus, so the walk is a walk. */
async function tabTo(page: Page, label: string): Promise<number> {
  for (let step = 1; step <= 14; step += 1) {
    await page.keyboard.press('Tab')
    const name = await page.evaluate(() => document.activeElement?.textContent?.trim() ?? null)
    if (name === label) {
      return step
    }
  }
  throw new Error(`no tab stop named ${label} within 14 presses`)
}

/** The ring box of whatever holds focus: the element box plus outline and offset. */
async function focusedRing(page: Page): Promise<Ring> {
  return page.evaluate((ring) => {
    const rect = document.activeElement?.getBoundingClientRect()
    if (rect === undefined) {
      throw new Error('nothing holds focus')
    }
    return {
      left: rect.left - ring,
      top: rect.top - ring,
      right: rect.right + ring,
      bottom: rect.bottom + ring,
    }
  }, RING)
}

const probes = (ring: Ring): { side: string; x: number; y: number }[] => {
  const midX = Math.round((ring.left + ring.right) / 2)
  const midY = Math.round((ring.top + ring.bottom) / 2)
  return [
    { side: 'left', x: Math.round(ring.left) + 1, y: midY },
    { side: 'right', x: Math.round(ring.right) - 1, y: midY },
    { side: 'top', x: midX, y: Math.round(ring.top) + 1 },
    { side: 'bottom', x: midX, y: Math.round(ring.bottom) - 1 },
  ]
}

const isAccent = (rgb: [number, number, number] | null): boolean =>
  rgb !== null &&
  Math.max(
    Math.abs(rgb[0] - ACCENT[0]),
    Math.abs(rgb[1] - ACCENT[1]),
    Math.abs(rgb[2] - ACCENT[2]),
  ) <= TOLERANCE

const attachPng = (testInfo: TestInfo, name: string, body: Buffer): Promise<void> =>
  testInfo.attach(name, { body, contentType: 'image/png' })

const FACTS = 'section[aria-labelledby="facts-heading"] li'

const factOpacities = (page: Page): Promise<string[]> =>
  page.evaluate((selector) => {
    const facts = [...document.querySelectorAll(selector)]
    return facts.map((fact) => getComputedStyle(fact).opacity)
  }, FACTS)

test('names the run it measured', async ({ browser }, testInfo) => {
  // The report has to say what it looked at: the SHA the job actually checked
  // out, the head the PR submits, the browser, the viewport and DPR, and
  // where the data came from. Fixture data only; this job never touches a
  // live RPC or a provider, and holds no credentials.
  const checkoutSha = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: `${import.meta.dirname}/..`,
    encoding: 'utf8',
  }).trim()
  const prHeadSha = process.env.EVIDENCE_HEAD_SHA ?? null
  const repository = process.env.GITHUB_REPOSITORY
  const runId = process.env.GITHUB_RUN_ID
  const provenance = {
    checkoutSha,
    prHeadSha,
    note:
      prHeadSha === checkoutSha || prHeadSha === null
        ? 'the job ran on the submitted head'
        : 'the checkout differs from the submitted head; treat the evidence as belonging to the checkout',
    ciRun:
      repository !== undefined && runId !== undefined
        ? `https://github.com/${repository}/actions/runs/${runId}`
        : 'local run',
    browser: `chromium ${browser.version()}, headless`,
    project: testInfo.project.name,
    viewport: testInfo.project.use.viewport ?? null,
    deviceScaleFactor: testInfo.project.use.deviceScaleFactor ?? null,
    build: 'production bundle served by vite preview',
    data: 'labelled fixture data from e2e/fixture-api.mjs behind the same-origin proxy; no live RPC, no provider, no real chain state, no credentials',
  }
  await testInfo.attach('run-provenance', {
    body: JSON.stringify(provenance, null, 2),
    contentType: 'application/json',
  })
})

test('keeps every focused destination ring inside the viewport, painted', async ({
  page,
  context,
}, testInfo) => {
  await seedSession(context)
  const measurements: object[] = []

  for (const route of [
    { path: '/', label: 'Overview' },
    { path: '/wallets', label: 'Wallets' },
  ]) {
    await page.goto(route.path)
    await page.waitForSelector('nav[aria-label="Sections"] a')
    await page.waitForFunction(() => document.body.textContent?.includes('@') === true)

    const presses = await tabTo(page, route.label)
    const ring = await focusedRing(page)
    const viewport = page.viewportSize()
    expect(viewport, 'viewport size').not.toBeNull()

    const inside =
      ring.left >= 0 &&
      ring.top >= 0 &&
      ring.right <= (viewport?.width ?? 0) &&
      ring.bottom <= (viewport?.height ?? 0)
    expect(inside, `${route.label} ring ${JSON.stringify(ring)} leaves the viewport`).toBe(true)

    const shot = await page.screenshot()
    const png = decodePng(shot)
    for (const probe of probes(ring)) {
      expect(isAccent(png.at(probe.x, probe.y)), `${route.label} ring ${probe.side} not painted`).toBe(true)
    }

    measurements.push({ route: route.path, label: route.label, presses, ring })
    await attachPng(testInfo, `${testInfo.project.name}-${route.label}`, shot)
  }

  await testInfo.attach('ring-measurements', {
    body: JSON.stringify(measurements, null, 2),
    contentType: 'application/json',
  })
})

test('keeps a scrolled last control ring clear of the fixed strip', async ({
  page,
  context,
}, testInfo) => {
  testInfo.skip(testInfo.project.name !== 'mobile', 'the strip is fixed only below 48rem')
  await seedSession(context)

  await page.goto('/')
  await page.waitForSelector('nav[aria-label="Sections"] a')

  // Throwaway length and one control at the end of the document, injected
  // into the loaded page. The tail is the room the scrollport needs below the
  // control for the reserve to be the thing that lifts it.
  await page.evaluate(() => {
    const lead = document.createElement('div')
    lead.style.blockSize = '1600px'
    const holder = document.createElement('div')
    const button = document.createElement('button')
    button.type = 'button'
    button.className = document.querySelector('header button')?.className ?? ''
    button.textContent = 'Fixture: last control'
    holder.append(button)
    const tail = document.createElement('div')
    tail.style.blockSize = '200px'
    document.body.append(lead, holder, tail)
  })

  await tabTo(page, 'Fixture: last control')
  await page.evaluate(() => {
    document.activeElement?.scrollIntoView({ block: 'end', inline: 'nearest' })
  })
  await page.waitForTimeout(150)

  const measured = await page.evaluate((ring) => {
    const rect = document.activeElement?.getBoundingClientRect()
    const nav = document.querySelector('nav[aria-label="Sections"]')?.getBoundingClientRect()
    if (rect === undefined || nav === undefined) {
      throw new Error('the fixture control or the strip is missing')
    }
    return {
      ringBottom: rect.bottom + ring,
      stripTop: nav.top,
      gapToViewportBottom: window.innerHeight - rect.bottom,
    }
  }, RING)

  // The root scroller's padding is the reserve: 77px at the default root size.
  expect(measured.gapToViewportBottom).toBeGreaterThan(76.5)
  expect(measured.gapToViewportBottom).toBeLessThan(77.5)
  expect(measured.stripTop - measured.ringBottom).toBeGreaterThan(0)

  await attachPng(testInfo, 'scroll-fixture', await page.screenshot())
})

test('keeps every fact reachable on both auth routes, at both bottom insets', async ({
  browser,
}, testInfo) => {
  testInfo.skip(testInfo.project.name !== 'mobile', 'the reproduction this answers is a phone-size case')

  type MatrixCase = {
    route: string
    variant: string
    mode: string
    viewportHeight: number
    scrollPaddingBottom: string
    scrollRange: number
    opacities: string[]
  }
  const cases: MatrixCase[] = []

  for (const route of ['/login', '/register']) {
    for (const variant of [
      { label: 'zero-safe-area', css: null, expectedPadding: '77px' },
      {
        label: 'positive-safe-area',
        // Headless Chromium exposes no native env(safe-area-inset-*) override,
        // so the 34px safe-area case enters where the reserve writes it: a
        // root scroll-padding override of 77px + 34px. That is the exact
        // property a default (auto) view-timeline inset reads, and the
        // shipped timeline inset is 0, so the sequence must now read neither.
        css: 'html { scroll-padding-bottom: 111px !important; }',
        expectedPadding: '111px',
      },
    ]) {
      for (const mode of ['scrolled-to-bottom', 'just-fitting'] as const) {
        const context = await browser.newContext({ viewport: { width: 360, height: 740 } })
        if (variant.css !== null) {
          await context.addInitScript((cssText) => {
            const attach = (): void => {
              const style = document.createElement('style')
              style.textContent = cssText
              document.documentElement.append(style)
            }
            if (document.documentElement !== null) {
              attach()
            } else {
              document.addEventListener('DOMContentLoaded', attach)
            }
          }, variant.css)
        }
        const page = await context.newPage()
        await page.goto(route)
        await page.waitForSelector(FACTS)
        await expect(page.locator(FACTS)).toHaveCount(4)

        let viewportHeight = 740
        if (mode === 'just-fitting') {
          // The viewport the content exactly fills: no scroll range at all,
          // so every fact has to read whole on load.
          viewportHeight = await page.evaluate(() => document.documentElement.scrollHeight)
          await page.setViewportSize({ width: 360, height: viewportHeight })
          await page.waitForTimeout(200)
        } else {
          await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight))
          await page.waitForTimeout(300)
        }

        const state = await page.evaluate(() => ({
          scrollPaddingBottom: getComputedStyle(document.documentElement).scrollPaddingBottom,
          scrollRange: document.documentElement.scrollHeight - window.innerHeight,
        }))
        const opacities = await factOpacities(page)

        cases.push({
          route,
          variant: variant.label,
          mode,
          viewportHeight,
          scrollPaddingBottom: state.scrollPaddingBottom,
          scrollRange: state.scrollRange,
          opacities,
        })
        await attachPng(
          testInfo,
          `reach-${route.slice(1)}-${variant.label}-${mode}`,
          await page.screenshot(),
        )
        await context.close()
      }
    }
  }

  await testInfo.attach('reachability-matrix', {
    body: JSON.stringify(
      {
        method:
          'Eight cases: both auth routes at a zero and at a positive bottom inset, each scrolled to the bottom of the reachable range and each in a just-fitting viewport with no scroll range. The positive inset is a root scroll-padding-bottom override of 111px, the 77px reserve plus a 34px safe area, applied because headless Chromium has no native env(safe-area-inset-*) override. The override enters at the exact property the reserve writes and a default (auto) view timeline inset reads; the shipped timeline declares view(block 0px) and must be independent of it.',
        cases,
      },
      null,
      2,
    ),
    contentType: 'application/json',
  })

  for (const entry of cases) {
    const where = `${entry.route} ${entry.variant} ${entry.mode}`
    const expectedPadding = entry.variant === 'zero-safe-area' ? '77px' : '111px'
    expect(entry.scrollPaddingBottom, `${where} root inset`).toBe(expectedPadding)
    if (entry.mode === 'just-fitting') {
      expect(entry.scrollRange, `${where} must have no scroll range`).toBeLessThanOrEqual(0)
    }
    entry.opacities.forEach((opacity, index) => {
      expect(opacity, `${where} fact ${index} opacity`).toBe('1')
    })
  }
})

test.describe('the reduced-motion reader', () => {
  test.use({ reducedMotion: 'reduce' })

  test('gets the four facts complete and static, without scrolling', async ({ page }) => {
    await page.goto('/login')
    const facts = page.locator('section[aria-labelledby="facts-heading"] li')
    await expect(facts).toHaveCount(4)

    for (let index = 0; index < 4; index += 1) {
      const fact = facts.nth(index)
      expect(await fact.evaluate((el) => getComputedStyle(el).opacity), `fact ${index} opacity`).toBe('1')
      expect(await fact.evaluate((el) => getComputedStyle(el).animationName), `fact ${index} animation`).toBe(
        'none',
      )
    }
  })
})

test('holds the frame alarm while a fact is actually settling', async ({
  page,
  browser,
  context,
}, testInfo) => {
  testInfo.skip(testInfo.project.name !== 'mobile', 'measured once at the phone size')

  // Pick the fact whose live entry window is widest inside the scroll the
  // page actually has, so the sampler measures frames where the sequence
  // moves rather than an idle page. Register carries more form above the
  // facts than login does, so its facts enter inside the reachable range.
  await page.goto('/register')
  await page.waitForSelector(FACTS)
  const target = await page.evaluate((selector) => {
    type LiveWindow = {
      index: number
      start: number
      end: number
      width: number
      maxScroll: number
    }
    const viewport = window.innerHeight
    const maxScroll = Math.max(0, document.documentElement.scrollHeight - viewport)
    const candidates: LiveWindow[] = []
    document.querySelectorAll(selector).forEach((fact, index) => {
      const rect = fact.getBoundingClientRect()
      const top = rect.top + window.scrollY
      // The shipped range is entry 0% to entry 70% against the true
      // scrollport: the inset is explicit in the function, view(block 0px),
      // because an argument-less view() defaults to auto and would read the
      // root's scroll padding.
      const start = Math.max(0, top - viewport)
      const end = Math.min(maxScroll, top - viewport + 0.7 * rect.height)
      candidates.push({ index, start, end, width: end - start, maxScroll })
    })
    let best: LiveWindow | null = null
    for (const candidate of candidates) {
      if (best === null || candidate.width > best.width) {
        best = candidate
      }
    }
    return best
  }, FACTS)
  if (target === null) {
    throw new Error('no fact has a live entry window on /register at 360x740')
  }
  expect(target.width, 'the live entry window is too narrow to measure').toBeGreaterThanOrEqual(12)

  const client = await context.newCDPSession(page)
  await client.send('Emulation.setCPUThrottlingRate', { rate: 4 })
  await client.send('Network.emulateNetworkConditions', {
    offline: false,
    latency: 150,
    downloadThroughput: 209715,
    uploadThroughput: 96000,
  })

  const chunks: unknown[] = []
  client.on('Tracing.dataCollected', (event) => {
    chunks.push(...((event as { value: unknown[] }).value ?? []))
  })
  const tracingDone = new Promise((resolve) => {
    client.once('Tracing.tracingComplete', resolve)
  })
  await client.send('Tracing.start', {
    categories: 'devtools.timeline',
    transferMode: 'ReportEvents',
  })

  // Sample the chosen fact's progress every frame while a wheel walk drives
  // one continuous scroll from the top to the bottom of the reachable range.
  const sampler = page.evaluate(
    ({ selector, index, budgetMs }) =>
      new Promise<{ t: number; progress: number | null }[]>((resolve) => {
        const fact = document.querySelectorAll(selector)[index]
        const samples: { t: number; progress: number | null }[] = []
        const start = performance.now()
        const tick = (now: number): void => {
          const animation = fact?.getAnimations()[0]
          const progress =
            animation !== undefined && animation.effect !== null
              ? (animation.effect.getComputedTiming().progress ?? null)
              : null
          samples.push({ t: now, progress })
          if (now - start < budgetMs) {
            requestAnimationFrame(tick)
          } else {
            resolve(samples)
          }
        }
        requestAnimationFrame(tick)
      }),
    { selector: FACTS, index: target.index, budgetMs: 6000 },
  )

  await page.mouse.move(180, 300)
  const stepPx = Math.max(6, Math.ceil(target.maxScroll / 36))
  for (let scrolled = 0; scrolled < target.maxScroll; scrolled += stepPx) {
    await page.mouse.wheel(0, stepPx)
    await page.waitForTimeout(110)
  }
  await page.waitForTimeout(300)

  const samples = await sampler

  await client.send('Tracing.end')
  await tracingDone

  const progressValues = samples
    .map((sample) => sample.progress)
    .filter((progress): progress is number => progress !== null)
  expect(progressValues.length, 'the sampled fact carries no live animation').toBeGreaterThan(0)
  expect(Math.min(...progressValues), 'the fact starts unsettled').toBeLessThan(0.05)
  expect(
    Math.max(...progressValues),
    'the fact finishes settling inside the reachable scroll',
  ).toBe(1)
  const interior = progressValues.filter((progress) => progress > 0.02 && progress < 0.98)
  expect(interior.length, 'the measured interval contains frames mid-settle').toBeGreaterThanOrEqual(3)

  // Active frames: from the frame before the progress starts moving to the
  // frame where it reaches 1. The alarm is evaluated on those, not on the
  // idle tail of the sample.
  const firstLive = samples.findIndex((sample) => (sample.progress ?? 0) > 0)
  const settled = samples.findIndex((sample) => sample.progress === 1)
  expect(settled, 'the fact settles inside the sampled interval').toBeGreaterThan(firstLive)
  const active = samples.slice(Math.max(0, firstLive - 1), settled + 1)
  const intervals: number[] = []
  for (let index = 1; index < active.length; index += 1) {
    const previous = active[index - 1]
    const current = active[index]
    if (previous !== undefined && current !== undefined) {
      intervals.push(current.t - previous.t)
    }
  }
  const sorted = [...intervals].sort((one, other) => one - other)
  const median = sorted[Math.floor(sorted.length / 2)] ?? 0
  const worst = sorted[sorted.length - 1] ?? 0

  const measurement = {
    browser: `chromium ${browser.version()}`,
    preset: '4x CPU throttle, Slow 4G at 150ms RTT, 1.6 Mbit/s down and 0.75 Mbit/s up',
    route: '/register',
    viewport: page.viewportSize(),
    fact: target.index,
    reachableScrollPx: target.maxScroll,
    liveEntryWindowPx: { start: target.start, end: target.end, width: target.width },
    framesSampled: samples.length,
    activeFrames: active.length,
    interiorProgressSamples: interior.length,
    medianActiveFrameMs: Number(median.toFixed(2)),
    worstActiveFrameMs: Number(worst.toFixed(2)),
    alarm:
      'coarse alarm only: median active frame interval at or under 20ms and worst at or under 100ms. The acceptance requirement stays the 60fps bar judged against the attached trace on this named browser and preset, recorded in the brief section 13. A sequence that trips the alarm leaves the tree and the static composition ships.',
  }
  await testInfo.attach('frame-measurement', {
    body: JSON.stringify(measurement, null, 2),
    contentType: 'application/json',
  })
  await testInfo.attach('auth-frame-trace', {
    body: Buffer.from(JSON.stringify(chunks)),
    contentType: 'application/json',
  })

  expect(measurement.medianActiveFrameMs).toBeLessThanOrEqual(20)
  expect(measurement.worstActiveFrameMs).toBeLessThanOrEqual(100)
})
