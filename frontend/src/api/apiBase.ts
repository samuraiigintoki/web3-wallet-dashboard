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
 * constant: no request builds a URL from anything else.
 *
 * The value ends up in the bundle, so it is a public URL and nothing more. It
 * must never carry a credential, and a value that does is refused rather than
 * shipped: `https://user:password@host/api/v1` is a valid URL, so it would
 * otherwise pass every check and publish the password to anyone who opens the
 * bundle.
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
 * The value as it is safe to print in an error, because an error thrown at build
 * time lands in a CI log that more people read than the one who typed it.
 *
 * Anything containing `@` is redacted whole rather than partly masked. A regex
 * that replaces the text before the first `@` looks right and is not:
 * `https://user:@s3cr3t@api.example.com/api/v1` keeps `s3cr3t`, which is exactly
 * the credential the message is trying to protect. There is no safe partial form
 * for a string whose shape is the thing under suspicion, so the shape is all that
 * is printed.
 */
function printable(value: string): string {
  if (value.includes('@')) {
    return `<redacted: ${value.length} characters, and it contains an @>`
  }

  return `"${value}"`
}

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
      `VITE_API_BASE_URL must be an absolute http(s) URL or a path beginning with /, and it was ${printable(value)}.`,
    )
  }

  // A URL may carry a username and password, and this one is published in the
  // bundle. Refusing it here is the difference between a failed build and a
  // credential in every visitor's browser cache.
  if (ABSOLUTE_BASE.test(value)) {
    let parsed: URL
    try {
      parsed = new URL(value)
    } catch {
      throw new Error(
        `VITE_API_BASE_URL must be a URL this build can parse, and it was ${printable(value)}.`,
      )
    }

    if (parsed.username !== '' || parsed.password !== '') {
      // Not even the host is printed here. The value is the thing that is wrong,
      // and the one safe amount of it to publish is how long it was.
      throw new Error(
        `VITE_API_BASE_URL must not carry a username or password, because it is compiled into the browser bundle. The value was redacted: it is ${value.length} characters.`,
      )
    }
  }

  return value.replace(/\/+$/, '')
}