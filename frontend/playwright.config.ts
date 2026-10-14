import { defineConfig } from '@playwright/test'

/**
 * The browser-evidence job's configuration.
 *
 * The walks run against the production build served by `vite preview`, with
 * the fixture API behind the same proxy the dev server uses, so what is
 * measured is the shipped bundle and not a development transform. Browser
 * discovery stays here, separate from Vitest and jsdom: nothing under src or
 * guards is picked up by this runner, and nothing here is picked up by
 * Vitest.
 */
export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  retries: 0,
  reporter: [['html', { open: 'never' }]],
  use: {
    baseURL: 'http://127.0.0.1:4173',
    deviceScaleFactor: 1,
    video: 'on',
  },
  projects: [
    {
      name: 'mobile',
      use: { viewport: { width: 360, height: 740 } },
    },
    {
      name: 'desktop',
      use: { viewport: { width: 1440, height: 900 } },
    },
  ],
  webServer: [
    {
      command: 'node e2e/fixture-api.mjs',
      url: 'http://127.0.0.1:8099/healthz',
      reuseExistingServer: false,
    },
    {
      command: 'npm run build && npx vite preview --port 4173 --strictPort --host 127.0.0.1',
      url: 'http://127.0.0.1:4173/',
      reuseExistingServer: false,
      timeout: 180_000,
      env: {
        API_PROXY_TARGET: 'http://127.0.0.1:8099',
      },
    },
  ],
})
