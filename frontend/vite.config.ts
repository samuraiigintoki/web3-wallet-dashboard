import react from '@vitejs/plugin-react'
import { defineConfig, loadEnv } from 'vite'

const DEFAULT_API_PROXY_TARGET = 'http://localhost:8080'

// API_PROXY_TARGET carries no VITE_ prefix, so Vite never inlines it into the
// bundle. Reading it needs loadEnv with an empty prefix, which is the whole
// point: the value is for this config process only.
//
// The proxy is required rather than a convenience. The API sends no CORS
// headers, so the browser cannot call it on another origin. Keeping every
// request same-origin also keeps the bearer token on this origin.
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  const target = env.API_PROXY_TARGET || DEFAULT_API_PROXY_TARGET

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
