/**
 * The measuring side of the gate. Every figure the tests assert comes from
 * here, so a change of library or of formula shows up as a failing test rather
 * than as a quietly different number.
 */
import Color from 'colorjs.io'

export type Oklch = readonly [number, number, number]

/** Accepts `oklch(l c h)` or the bare triple the document writes. */
export function fromOklch(value: string | Oklch): Color {
  const [l, c, h] = typeof value === 'string' ? splitTriple(value) : value
  return new Color('oklch', [l, c, h])
}

export function splitTriple(value: string): [number, number, number] {
  const inner = /^oklch\(\s*(.*?)\s*\)$/.exec(value.trim())?.[1] ?? value
  const parts = inner.trim().split(/\s+/)
  if (parts.length !== 3) {
    throw new Error(`not an OKLCH value: ${value}`)
  }

  const [l, c, h] = parts.map(Number)
  if (l === undefined || c === undefined || h === undefined) {
    throw new Error(`not an OKLCH value: ${value}`)
  }

  return [l, c, h]
}

/** True when the colour needs no clipping to display in sRGB. */
export function inSrgb(colour: Color): boolean {
  return colour.inGamut('srgb', { epsilon: 0 })
}

export function toHex(colour: Color): string {
  return colour.to('srgb').toString({ format: 'hex', collapse: false }).toUpperCase()
}

/**
 * APCA lightness contrast, with APCA's own sign: negative when the text is
 * lighter than its background, which is the polarity this product is drawn in.
 *
 * colorjs.io computes the two arguments in the opposite order to the way they
 * read, so the call is made here once, next to the comment that says so, and
 * the known-answer test below pins the sign.
 */
export function apcaLc(text: Color, background: Color): number {
  return background.contrastAPCA(text)
}

export function wcagRatio(one: Color, other: Color): number {
  const [lighter, darker] = one.luminance > other.luminance ? [one, other] : [other, one]
  return (lighter.luminance + 0.05) / (darker.luminance + 0.05)
}
