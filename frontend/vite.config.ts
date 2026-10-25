import react from '@vitejs/plugin-react'
import { defineConfig, loadEnv } from 'vite'

import { resolveApiBase } from './src/api/apiBase.ts'

const DEFAULT_API_PROXY_TARGET = 'http://localhost:8080'

// API_PROXY_TARGET carries no VITE_ prefix, so Vite never inlines it into the
// bundle. Reading it needs loadEnv with an empty prefix, which is the whole
// point: the value is for this config process only.
//
// The proxy is still the default for local work, even though the API now sends
// CORS headers for a configured deployment origin: keeping every local request
// same-origin means no local run depends on the allowlist, and the bearer token
// never leaves this origin.
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  const target = env.API_PROXY_TARGET || DEFAULT_API_PROXY_TARGET

  // The deployed bundle bakes in the API origin, and a typo there ships an app
  // that answers no request correctly. Resolving it here, in the process that
  // builds, turns that into a failed build instead of a broken page. The browser
  // repeats the check when the bundle loads, which is the only place that can
  // catch a value injected by the host at build time rather than by this file.
  resolveApiBase(process.env.VITE_API_BASE_URL ?? env.VITE_API_BASE_URL)

  return {
    plugins: [react()],
    server: {
      proxy: {
        '/api': {
          target,
          changeOrigin: true,
        },
      },
    },
    test: {
      environment: 'jsdom',
      globals: false,
      setupFiles: ['./src/test/setup.ts'],
      include: ['src/**/*.test.{ts,tsx}'],
      restoreMocks: true,
    },
  }
})
