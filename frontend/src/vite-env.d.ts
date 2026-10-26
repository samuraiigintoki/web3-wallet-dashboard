/// <reference types="vite/client" />

/**
 * The environment values this build reads.
 *
 * One value, and it is a public URL: the deployed API's base. Everything else
 * the application needs is decided by the server or by the wallet, so an
 * undeclared variable here is a mistake rather than a setting.
 */
interface ImportMetaEnv {
  readonly VITE_API_BASE_URL?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
