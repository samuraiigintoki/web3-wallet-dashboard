/**
 * The browser walks: rendered evidence as a CI job.
 *
 * Every walk runs against the production build served by `vite preview`, with
 * the fixture API on 8099 behind the dev proxy. The data is labelled fixture
 * data: one route, one identity, no chain, no wallet, no transaction. What is
 * measured here is geometry and paint, the two things a source guard cannot
 * see: the ring box against the viewport, the accent painted where the ring
 * should be, the reserve holding a scrolled control clear of the strip, the
 * sequence settling for a scrolling reader and reading whole for a reduced
 * one, and the frame budget of the sequence under a throttled profile.
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

test('names the run it measured', async ({ browser }, testInfo) => {
  // The report has to say what it looked at: the exact head, the browser, the
  // viewport and DPR, and where the data came from. Fixture data only; this
  // job never touches a live RPC or a provider, and holds no credentials.
  const head =
    process.env.GITHUB_SHA ??
    execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: `${import.meta.dirname}/..`,
      encoding: 'utf8',
    }).trim()
  const repository = process.env.GITHUB_REPOSITORY
  const runId = process.env.GITHUB_RUN_ID
  const provenance = {
    headSha: head,
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

test('settles every fact by the page bottom and whole with no scroll range', async ({
  page,
}, testInfo) => {
  testInfo.skip(testInfo.project.name !== 'mobile', 'measured once at the phone size')

  await page.goto('/login')
  const facts = page.locator('section[aria-labelledby="facts-heading"] li')
  await expect(facts).toHaveCount(4)

  // The strip reserve insets the timeline's scrollport (view-timeline-inset
  // auto reads scroll-padding), so a fact below the inset line is held even
  // while its first pixels are technically inside the viewport.
  const held = await page.evaluate(() => {
    const list = document.querySelectorAll('section[aria-labelledby="facts-heading"] li')
    const last = list[list.length - 1]?.getBoundingClientRect()
    const reserve = parseFloat(getComputedStyle(document.documentElement).scrollPaddingBottom)
    return last !== undefined && last.top > window.innerHeight - reserve
  })

  if (held) {
    expect(await facts.nth(3).evaluate((el) => getComputedStyle(el).opacity)).toBe('0')
  }

  // At the bottom of the page every fact has settled completely. The range
  // end has to fit inside the scroll this page actually has, and this is the
  // measurement that says so.
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight))
  await page.waitForTimeout(400)
  for (let index = 0; index < 4; index += 1) {
    expect(
      await facts.nth(index).evaluate((el) => getComputedStyle(el).opacity),
      `fact ${index} at the page bottom`,
    ).toBe('1')
  }

  // A viewport with no scroll range shows every fact completely, on load.
  await page.evaluate(() => window.scrollTo(0, 0))
  await page.setViewportSize({ width: 360, height: 2400 })
  await page.waitForTimeout(300)
  for (let index = 0; index < 4; index += 1) {
    expect(await facts.nth(index).evaluate((el) => getComputedStyle(el).opacity), `fact ${index}`).toBe('1')
  }

  await attachPng(testInfo, 'no-scroll-range', await page.screenshot())
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

test('holds the sequence frame budget at 4x CPU and Slow 4G', async ({
  page,
  browser,
  context,
}, testInfo) => {
  testInfo.skip(testInfo.project.name !== 'mobile', 'measured once at the phone size')

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

  await page.goto('/login')
  await page.waitForSelector('section[aria-labelledby="facts-heading"] li')

  const sampler = page.evaluate(
    () =>
      new Promise<number[]>((resolve) => {
        const deltas: number[] = []
        let last = performance.now()
        const start = last
        const tick = (now: number): void => {
          deltas.push(now - last)
          last = now
          if (now - start < 2400) {
            requestAnimationFrame(tick)
          } else {
            resolve(deltas)
          }
        }
        requestAnimationFrame(tick)
      }),
  )

  for (let step = 1; step <= 8; step += 1) {
    await page.evaluate((fraction) => {
      window.scrollTo(0, (document.documentElement.scrollHeight * fraction) / 8)
    }, step)
    await page.waitForTimeout(280)
  }

  const deltas = await sampler
  const frames = deltas.slice(2).sort((one, other) => one - other)
  const median = frames[Math.floor(frames.length / 2)] ?? 0
  const worst = frames[frames.length - 1] ?? 0

  await client.send('Tracing.end')
  await tracingDone

  const measurement = {
    browser: `chromium ${browser.version()}`,
    preset: '4x CPU throttle, Slow 4G at 150ms RTT, 1.6 Mbit/s down and 0.75 Mbit/s up',
    viewport: page.viewportSize(),
    framesSampled: frames.length,
    medianFrameMs: Number(median.toFixed(2)),
    worstFrameMs: Number(worst.toFixed(2)),
    rule: 'median at or under 20ms and worst at or under 100ms, or the sequence leaves the tree',
  }
  await testInfo.attach('frame-measurement', {
    body: JSON.stringify(measurement, null, 2),
    contentType: 'application/json',
  })
  await testInfo.attach('auth-frame-trace', {
    body: Buffer.from(JSON.stringify(chunks)),
    contentType: 'application/json',
  })

  expect(measurement.medianFrameMs).toBeLessThanOrEqual(20)
  expect(measurement.worstFrameMs).toBeLessThanOrEqual(100)
})
