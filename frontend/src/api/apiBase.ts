/**
 * The base every request is made against.
 *
 * Locally this is `/api/v1`, a relative path the Vite dev server proxies to the
 * API, so the browser only ever talks to one origin. A deployment serves the
 * frontend from a static host and the API from a separate service, and there is
 * no proxy in front of a static file server, so the deployed build names the API
 * origin at build time.
 *
 * `VITE_API_BASE_URL` is that name. It is validated by the Vite config, so a bad
 * value fails the build instead of shipping, and validated again when the bundle
 * loads, so nothing downstream can see an unchecked value. After that it is a
 * constant: no request builds a URL from anything else. The value ends up in the bundle, so it is a public
 * URL and nothing more. It must never carry a credential.
 */
export const DEFAULT_API_BASE = '/api/v1'

/** An absolute http(s) base, or a rooted path. */
const ABSOLUTE_BASE = /^https?:\/\/[^/?#\s]+(?:\/[^?#\s]*)?$/
/**
 * A path from this origin. `//host` is refused: a protocol-relative value
 * resolves to whatever scheme the page is on, which is a URL somebody else
 * chose, not a path.
 */
const ROOTED_PATH = /^\/(?!\/)[^?#\s]*$/

/**
 * Reads the configured base, or refuses it.
 *
 * A value that is not a rooted path or an absolute http(s) URL is a build
 * failure rather than a runtime surprise: a typo here would otherwise surface as
 * every request in the deployed app going to the wrong place. The trailing slash
 * is stripped because every caller appends a path that already begins with one.
 */
export function resolveApiBase(raw: string | undefined): string {
  const value = raw?.trim() ?? ''

  if (value === '') {
    return DEFAULT_API_BASE
  }

  if (!ABSOLUTE_BASE.test(value) && !ROOTED_PATH.test(value)) {
    throw new Error(
      `VITE_API_BASE_URL must be an absolute http(s) URL or a path beginning with /, and it was "${value}".`,
    )
  }

  return value.replace(/\/+$/, '')
}