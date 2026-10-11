/**
 * The bridge between the design direction and the stylesheet.
 *
 * The gate reads both files rather than restating either. A palette copied
 * into a test would pass forever while the document and the stylesheet drifted
 * apart, which is the failure this is here to catch.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'

export const frontendRoot = resolve(import.meta.dirname, '..')
export const repoRoot = resolve(frontendRoot, '..')

export const files = {
  tokens: resolve(frontendRoot, 'src/styles/tokens.css'),
  indexHtml: resolve(frontendRoot, 'index.html'),
  src: resolve(frontendRoot, 'src'),
  direction: resolve(repoRoot, 'docs/design/direction.md'),
  notice: resolve(repoRoot, 'docs/design/NOTICE.md'),
  packageJson: resolve(frontendRoot, 'package.json'),
} as const

export function read(path: string): string {
  return readFileSync(path, 'utf8')
}

export type DocumentColour = {
  /** The OKLCH triple as written in the document, for example `0.155 0.008 75`. */
  oklch: string
  /** The sRGB hex as written in the document. */
  hex: string
}

const OKLCH_TRIPLE = /^\d\.\d+ \d\.\d+ \d+$/
const HEX = /^#[0-9A-Fa-f]{6}$/
const TOKEN_NAME = /^--[a-z0-9-]+$/

type Item = { kind: 'token' | 'oklch' | 'hex'; value: string }

/**
 * Every colour token the direction names, taken from its tables.
 *
 * Only table rows count. The losing options in the decision record carry
 * values in prose, and those must not become tokens.
 */
export function parseDocumentColours(markdown: string): Map<string, DocumentColour> {
  const colours = new Map<string, DocumentColour>()

  for (const line of markdown.split('\n')) {
    if (!line.startsWith('|')) {
      continue
    }

    const items: Item[] = []
    for (const match of line.matchAll(/`([^`]+)`/g)) {
      const value = match[1]?.trim() ?? ''
      if (TOKEN_NAME.test(value)) {
        items.push({ kind: 'token', value })
      } else if (OKLCH_TRIPLE.test(value)) {
        items.push({ kind: 'oklch', value })
      } else if (HEX.test(value)) {
        items.push({ kind: 'hex', value })
      }
    }

    // A token owns the first value of each kind that follows it, up to the
    // next token. That covers the single-value tables and the state table,
    // where a tint token and its two values share one cell.
    for (const [index, item] of items.entries()) {
      if (item.kind !== 'token') {
        continue
      }

      let oklch: string | undefined
      let hex: string | undefined
      for (let ahead = index + 1; ahead < items.length; ahead += 1) {
        const next = items[ahead]
        if (next === undefined || next.kind === 'token') {
          break
        }
        if (next.kind === 'oklch') {
          oklch ??= next.value
        } else {
          hex ??= next.value
        }
      }

      if (oklch === undefined || hex === undefined) {
        continue
      }

      const existing = colours.get(item.value)
      if (existing !== undefined && (existing.oklch !== oklch || existing.hex !== hex)) {
        throw new Error(
          `the document gives ${item.value} two different values: ` +
            `${existing.oklch} ${existing.hex} and ${oklch} ${hex}`,
        )
      }

      colours.set(item.value, { oklch, hex })
    }
  }

  return colours
}

/** Every custom property declared on `:root` in the stylesheet. */
export function parseCssTokens(css: string): Map<string, string> {
  const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, '')
  const root = /:root\s*\{([\s\S]*?)\n\}/.exec(withoutComments)
  if (root?.[1] === undefined) {
    throw new Error('no :root block found in the stylesheet')
  }

  const tokens = new Map<string, string>()
  for (const match of root[1].matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)) {
    const name = match[1]
    const value = match[2]?.trim()
    if (name !== undefined && value !== undefined) {
      tokens.set(name, value)
    }
  }

  return tokens
}

/**
 * A token's value with every `var()` reference followed to the end.
 *
 * Returns null when a reference cannot be resolved, which is itself a failure
 * worth reporting rather than a value worth guessing.
 */
export function resolveToken(name: string, tokens: Map<string, string>): string | null {
  return resolveFrom(name, tokens, new Set())
}

function resolveFrom(name: string, tokens: Map<string, string>, seen: Set<string>): string | null {
  if (seen.has(name)) {
    throw new Error(`${name} resolves through itself`)
  }
  seen.add(name)

  const value = tokens.get(name)
  if (value === undefined) {
    return null
  }

  const reference = /^var\((--[a-z0-9-]+)\)$/.exec(value.trim())
  if (reference?.[1] === undefined) {
    return value
  }

  return resolveFrom(reference[1], tokens, seen)
}

/** The OKLCH triple inside `oklch(l c h)`, or null when the value is not one. */
export function parseOklch(value: string): [number, number, number] | null {
  const match = /^oklch\(\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)\s*\)$/.exec(value.trim())
  if (match === null) {
    return null
  }

  return [Number(match[1]), Number(match[2]), Number(match[3])]
}

/** Custom properties whose value looks like a colour, aliases included. */
export function colourTokens(tokens: Map<string, string>): string[] {
  return [...tokens.keys()].filter((name) => {
    const resolved = resolveToken(name, tokens)
    return resolved !== null && parseOklch(resolved) !== null
  })
}

export type GateRole = { lc: number; wcag: number | null }

/**
 * The thresholds the document records for each role, read from its table.
 *
 * The gate measures against these rather than against a copy, so a threshold
 * moves by editing the direction, not the test.
 */
export function parseGateRoles(markdown: string): Map<string, GateRole> {
  const roles = new Map<string, GateRole>()

  for (const line of markdown.split('\n')) {
    if (!line.startsWith('|')) {
      continue
    }

    const cells = line
      .replace(/^\|/, '')
      .split('|')
      .map((cell) => cell.trim())

    const lc = cells.find((cell) => /^Lc \d+/.test(cell))
    if (lc === undefined || cells.length < 4) {
      continue
    }

    const role = cells[0]
    if (role === undefined || role === '' || role.startsWith('-')) {
      continue
    }

    const magnitude = /Lc (\d+)/.exec(lc)?.[1]
    if (magnitude === undefined) {
      continue
    }

    const wcagCell = cells.find((cell) => /^[\d.]+:1$/.test(cell))
    const wcag = wcagCell === undefined ? null : Number(wcagCell.replace(':1', ''))

    // The size column is informational for the gate; the role name is what
    // pairs are declared against.
    roles.set(role, { lc: Number(magnitude), wcag })
  }

  return roles
}

const SKIPPED = new Set(['node_modules', '.git', 'dist', 'coverage'])

/** Every file under a directory that the predicate accepts. */
export function filesUnder(directory: string, predicate: (name: string) => boolean): string[] {
  const found: string[] = []

  for (const entry of readdirSync(directory)) {
    if (SKIPPED.has(entry)) {
      continue
    }

    const path = join(directory, entry)
    if (statSync(path).isDirectory()) {
      found.push(...filesUnder(path, predicate))
    } else if (predicate(entry)) {
      found.push(path)
    }
  }

  return found
}

/** The size steps the direction lists in its type table. */
const TYPE_ROW = /\|\s*`(--type-[a-z]+)`\s*\|\s*(\d+)px\s*\|/

/**
 * Every token the direction names, with the value it gives.
 *
 * Three shapes cover the document: a declaration in backticks, a size in the
 * type table, and a colour, which comes from the palette tables instead.
 */
export function parseDocumentScale(markdown: string): Map<string, string> {
  const scale = new Map<string, string>()

  for (const match of markdown.matchAll(/`(--[a-z0-9-]+)\s*:\s*([^`]+)`/g)) {
    const name = match[1]
    const value = match[2]?.trim()
    if (name !== undefined && value !== undefined) {
      scale.set(name, value)
    }
  }

  for (const line of markdown.split('\n')) {
    const row = TYPE_ROW.exec(line)
    const name = row?.[1]
    const px = row?.[2]
    if (name !== undefined && px !== undefined) {
      scale.set(name, `${Number(px) / 16}rem`)
    }
  }

  return scale
}

/** The 4px spacing base at the 16px rem baseline, for comparing px to rem. */
export function pxToRem(value: string): string | null {
  const match = /^(\d+(?:\.\d+)?)px$/.exec(value.trim())
  if (match?.[1] === undefined) {
    return null
  }

  return `${Number(match[1]) / 16}rem`
}

export type NoticedFont = { bytes: string; sha256: string }

/**
 * The vendored fonts as docs/design/NOTICE.md records them, by file name.
 *
 * The notice is the licence record a reviewer reads, so it is treated as a
 * source of truth and checked against the bytes on disk.
 */
export function parseNoticeFonts(markdown: string): Map<string, NoticedFont> {
  const noticed = new Map<string, NoticedFont>()

  for (const line of markdown.split('\n')) {
    if (!line.startsWith('|')) {
      continue
    }

    const cells = line
      .replace(/^\|/, '')
      .split('|')
      .map((cell) => cell.trim().replace(/^`|`$/g, ''))

    const file = cells.find((cell) => /^[\w.-]+\.woff2$/.test(cell))
    const bytes = cells.find((cell) => /^[\d,]+$/.test(cell))
    const sha256 = cells.find((cell) => /^[0-9a-f]{64}$/.test(cell))

    if (file !== undefined && bytes !== undefined && sha256 !== undefined) {
      noticed.set(file, { bytes: bytes.replaceAll(',', ''), sha256 })
    }
  }

  return noticed
}
