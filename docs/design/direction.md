# Design direction

Approved 2026-10-06. Lands at `docs/design/direction.md` in the product repository when the design system block opens, and that landing is what lifts the frontend freeze. The design system block is scoped from this document. It does not change Week 7 B1.

## The concept

The rail is the identity element. A measured line with ticks, on both surfaces and nothing decorative on top of it:

- In the app it is a transaction's life: submitted, confirmations indexed one by one, executed, or reorged out. The rail is the state machine, drawn.
- On the auth pages it is the same line run vertically as a spine, marking real product facts as the page scrolls.

The palette, type and motion below all exist to make that rail legible. Everything else in the app is quiet: plain surfaces, one accent, density where the data needs it.

## Palette

Warm near-black ground, one saturated accent. Values are OKLCH with the sRGB equivalent. Contrast is measured WCAG against the stated background and independently with APCA; the stricter of the two decides, and every figure below is measured rather than estimated.

### Contrast gate

Every pair is measured on both scales and the stricter figure decides. A threshold is never lowered to make a value pass.

| Role | Size | APCA | WCAG |
|---|---|---|---|
| Reading text | below 24px | Lc 75 | 4.5:1 |
| Supporting text | 14px and above | Lc 60 | 4.5:1 |
| Headings | 24px and above | Lc 45 | 3:1 |
| Non-text boundary, focus indicator | any | Lc 30 | 3:1 |
| Disabled text | any | Lc 15 minimum | not claimed |

Disabled text never carries information and is never the only way to read a state. Inactive controls are exempt from the ordinary text thresholds, and no compliance with them is claimed here.

A label on the accent fill uses the supporting role, at 14px and above at weight 600.

### Surfaces and lines

| Token | OKLCH | Hex | Notes |
|---|---|---|---|
| `--bg-0` page ground | `0.155 0.008 75` | `#0E0C09` | warm near-black, never slate |
| `--bg-1` raised panel | `0.190 0.008 75` | `#161310` | cards, panels, sidebar |
| `--bg-2` inset | `0.120 0.007 75` | `#070504` | wells, code, table header |
| `--bg-3` hover wash | `0.230 0.009 75` | `#1F1C18` | row and control hover |
| `--line` | `0.280 0.008 75` | `#2B2825` | 1px structure, never a control boundary |
| `--line-strong` | `0.360 0.010 75` | `#403C37` | focus-adjacent, active tabs |
| `--line-control` | `0.600 0.006 75` | `#82807C` | control and input borders, 4.3 to 5.1:1 and Lc 33 to 35 on all four surfaces |

A control boundary needs 3:1 and Lc 30. `--line` measures 1.27:1 and `--line-strong` 1.70:1 on `--bg-1`, so neither can bound an input; `--line-control` is the token that does.

### Text

| Token | OKLCH | Hex | Contrast on `--bg-0` |
|---|---|---|---|
| `--text-1` | `0.950 0.003 75` | `#F0EEEC` | 16.9:1 on `--bg-0`, Lc 95 or better on all four surfaces |
| `--text-2` | `0.860 0.004 75` | `#D2D1CE` | 12.8:1 on `--bg-0`, Lc 76 or better on all four surfaces |
| `--text-3` | `0.780 0.005 75` | `#B9B7B4` | 9.8:1 on `--bg-0`, Lc 61 or better on all four surfaces, 14px and above only |
| `--text-disabled` | `0.485 0.005 75` | `#615F5C` | 3.05:1 on `--bg-0`, never carries information |

Text at 12px and 13px uses `--text-1` or `--text-2`, where the reading bar is Lc 75. At the previous values `--text-2` measured Lc 62 to 64 and `--text-3` Lc 39 to 41, so neither could carry small text; `--text-3` now starts at 14px, where the supporting bar of Lc 60 applies. Text on a tint is `--text-1` in every case, including a selected row on `--accent-soft`. `--text-2` measures Lc 74.5 to 75.0 across the five tints, so it sits on the reading bar rather than clear of it, with no margin at all on any of them.

### Accent

Signal amber, hue 72. It is the brand and the waiting state, because waiting for other signers is the emotional center of a multisig.

| Token | OKLCH | Hex | Use |
|---|---|---|---|
| `--accent` | `0.780 0.150 72` | `#F2A635` | primary action, awaiting confirmations, current selection |
| `--accent-hover` | `0.830 0.139 72` | `#FFB757` | hover only, label Lc 71.7 |
| `--accent-soft` | `0.280 0.050 72` | `#382409` | chip and row tint |
| `--accent-ink` | `0.200 0.030 72` | `#1E1406` | text on accent, 8.9:1 and Lc 63.0. No dark ink can exceed Lc 64.2 on this fill, so a label on `--accent` is 14px and above at weight 600 |

The focus ring is `--accent`, 2px solid with a 2px offset, measured 9.0:1 on `--bg-1`. Chroma on `--accent-hover` is 0.139 because 0.140 is outside sRGB, where a browser clips it silently. Press is the 120ms transform on the rest colour, not a darker fill: a press colour at `0.720 0.150 72` measures Lc 53.2 for the label against Lc 63.0 at rest.

### Transaction and indexing states

| State | Token | OKLCH | Hex | Chip tint | Meaning |
|---|---|---|---|---|---|
| indexing, data not yet available | `--state-indexing` | `0.640 0.005 75` | `#8E8C89` | none | submitted to the chain, no indexed row yet |
| awaiting confirmations | `--state-awaiting` | `0.780 0.150 72` | `#F2A635` | `--accent-soft` `0.280 0.050 72` `#382409` | included in a block, confirmations counting up to the reversible window |
| executed | `--state-executed` | `0.740 0.130 155` | `#5EC386` | `--tint-executed` `0.280 0.050 155` `#12301E` | `ExecuteTransaction` indexed |
| revoked | `--state-revoked` | `0.660 0.120 20` | `#D17273` | `--tint-revoked` `0.280 0.050 20` `#3E1E1E` | `RevokeConfirmation` indexed |
| vanished | `--state-vanished` | `0.680 0.020 260` | `#9199A5` | `--tint-vanished` `0.280 0.050 260` `#1A2941` | was visible, no longer in the canonical result |
| error | `--state-error` | `0.700 0.170 27` | `#F66D62` | `--tint-error` `0.280 0.050 27` `#3E1F1B` | request or indexer failure |
| disabled indexing | `--state-disabled` | `0.485 0.005 75` | `#615F5C` | none | contract-level flag off |
| unsupported chain | `--state-unsupported` | `0.640 0.005 75` | `#8E8C89` | none | contract-level |

`--state-awaiting` is the same value as `--accent`, `--state-disabled` the same as `--text-disabled`, and `--state-unsupported` the same as `--state-indexing`. The three neutral states carry no tint, so a tint token exists for the five colored states only.

Chip tints are pinned above at 0.28 lightness in the state's own hue. A chip draws its label in `--text-1`, measured Lc 93 and 12.4 to 12.9:1 on every tint, and puts the state hue on the border, over a fill that is the state's own tint, where the hue measures 4.5 to 7.2:1 and Lc 38 to 59 against that tint, clear of the 3:1 and Lc 30 bar for non-text. Colored chip text would score Lc 38 to 59 and is not used. `disabled` and `unsupported` are never colored; they are explained in words.

Naming mapping, presentation only: the interface label `indexing` renders the wire value `pending`. The API's three-value contract is unchanged, and the backend's read-time mapping still governs the wire. `indexing` is not a backend state and must not be read as one. `disabled` and `unsupported` render neutral and worded, never colored.

The API serves canonical rows only, so `vanished` is a client-side observation: a transaction the user was looking at is no longer in the canonical result. Say that in words instead of dropping the row.

### Banned colors

Violet or indigo on near-black, any neon glow, halo shadows, gradient text, glassmorphism, mesh gradients. Violet-on-black with a glow is the single most common generated-UI default and the reason the accent was moved to amber.

## Type

One family plus one mono, both OFL, self-hosted, subset.

- `Geist Sans` for everything, weights 400, 500, 600. The `Instrument Sans` swap was rendered side by side with it and declined, on the pairing recorded below.
- `Geist Mono` for addresses, transaction hashes, block numbers and raw wei strings. Nowhere else. Mono is not a costume for technical. An amount formatted in ETH is sans with tabular figures, as are balances: mono is for the raw values, not for every number on the screen.
- Fixed rem scale, ratio about 1.2: 12 meta, 13 labels, 14 body, 16 lead, 19 section, 23 panel title, 28 page title. Auth headline may reach 40, app surfaces do not.
- Tabular numerals on every figure, always. No fluid clamp sizing in the app.
- Line height 1.5 body, 1.25 headings. Body measure 65 to 75ch in prose, tables may run denser.

Family tokens: `--font-sans: "Geist Sans", system-ui, sans-serif` and `--font-mono: "Geist Mono", ui-monospace, monospace`.

| Step token | Size | Use | Line height |
|---|---|---|---|
| `--type-meta` | 12px | meta only, paired with `--text-1` or `--text-2` | `--leading-body` |
| `--type-label` | 13px | labels, paired with `--text-1` or `--text-2` | `--leading-body` |
| `--type-body` | 14px | body | `--leading-body` |
| `--type-lead` | 16px | lead paragraphs and inputs | `--leading-body` |
| `--type-section` | 19px | section headings | `--leading-heading` |
| `--type-panel` | 23px | panel titles | `--leading-heading` |
| `--type-page` | 28px | page titles | `--leading-heading` |
| `--type-headline` | 40px | auth headline only | `--leading-heading` |

Line height: `--leading-body: 1.5`, `--leading-heading: 1.25`.

## Space, radius, elevation

- Spacing, 4px base: `--space-1: 4px`, `--space-2: 8px`, `--space-3: 12px`, `--space-4: 16px`, `--space-5: 24px`, `--space-6: 32px`, `--space-7: 48px`, `--space-8: 64px`.
- Named layout sizes: `--row-height: 44px` table row, `--pad-panel: 20px` panel padding, `--gutter-page: 24px` page gutter.
- Radius: `--radius-control: 10px`, `--radius-panel: 14px`, `--radius-pill: 999px` for chips and small toggles. Nothing above 16 on a panel; over-rounded product UI reads soft.
- Structure comes from `--line`, not shadow. Overlays only (menu, modal, toast) get one shadow token with offset and blur; that token is deferred with the overlays, because nothing in this block renders one. Never border plus shadow on a resting card, and never a zero-offset colored glow.

## Motion

Three easing tokens, from the vendored motion standards:

- `--ease-out: cubic-bezier(0.23, 1, 0.32, 1)` for entrances and settles, the default.
- `--ease-in-out: cubic-bezier(0.77, 0, 0.175, 1)` for movement already on screen.
- `--ease-drawer: cubic-bezier(0.32, 0.72, 0, 1)` for drawers and sheets.

Durations, named: `--duration-press: 120ms`, `--duration-feedback: 180ms` for hover and feedback, `--duration-state: 240ms`, `--duration-settle: 320ms`, and `--duration-ceiling: 480ms` for overlays and route transitions. Transform and opacity only. Never `transition: all`, never `ease-in` on UI, never `scale(0)`. Anything a user sees a hundred times a day does not animate. Every transition that moves more than a few pixels respects `prefers-reduced-motion`.

### The one authored moment: the block-time rail

Where: the transaction detail header, with a compact variant in transaction list rows.

What it shows, week by week, using only real data:

- Every tick is an indexed event's block number. Gaps are drawn to scale, so a slow block gap is visible. Nothing is interpolated or faked.
- Week 8, indexed facts only: on first data, ticks render statically; ticks that arrive later settle in over 240ms, opacity and 4px translate, staggered by 40ms, at most three at a time.
- Week 9, adds the browser-side read: the remaining reversible window shows as empty slots with a count, and the newest block is marked. Head never comes from the backend.
- Copy is exact: `indexed`, `seen in block 5,412,300`, `3 of 12 reversible window`, `executed in block 5,412,340`, `indexing` while no row exists. Never `confirmed`, never `final`, never a countdown, never confetti.
- Reduced motion: a static rail, numbers update in place.

### Auth surfaces

`/login` and `/register` carry the same rail as a vertical spine: as the page scrolls, ticks land at real product facts, in the product's own words, ending at the form. It is the product's only scroll-driven sequence, built on IntersectionObserver and CSS, no library. The spine is parked as its own later block: the design system restyles both pages as quiet forms built from the primitives, the form visible without scrolling, with the 240ms auth-to-app transition and no scroll sequence.

No WebGL, no 3D, no illustration, no mesh background, no scroll cue, no "scroll to explore". The form is visible without scrolling, and the headline is set in the product's own words, not a slogan.

### Auth to app

One short continuity motion, 240ms, transform and opacity, reduced motion respected. The rail element is continuous across the transition where the layout allows it. It is not a second signature moment.

## Do not

- No kicker or eyebrow labels, no numbered section markers, no hero-metric template, no identical card grids, no cards inside cards.
- No colored side stripe on cards or alerts, no hard offset shadows, no sparkline or progress-ring decoration, no emoji or glyph icons, no monospace as a texture.
- No fake data, ever, including in empty and demo states. Label illustrative values as illustrative or leave them out.
- No dark patterns: no fake urgency, no auto-dismissing errors, no confirmation delay to upsell.
- No em dashes or en dashes in interface copy. Ranges use hyphens.

## Decisions at the block

Each question below is settled by the criterion recorded with it. The losing option leaves no token, file or rule in the tree.

1. Accent hue: amber. Both ramps were rendered on the same screen and both run through the gate in full.

   Amber, as amended: accent `0.780 0.150 72` `#F2A635`, hover `0.830 0.139 72` `#FFB757`, soft `0.280 0.050 72` `#382409`, ink `0.200 0.030 72` `#1E1406`. Measured: ink on accent 8.85:1 and Lc 63.0, accent on `--bg-0` 9.53:1 Lc 62.4, on `--bg-1` 9.01:1 Lc 61.9, accent on its own tint 7.17:1 Lc 59.0, `--text-1` on that tint 12.70:1 Lc 93.3, ink on the hover 10.53:1 Lc 71.7.

   Chartreuse, built to the same shape: all four values below are inside sRGB. Accent `0.780 0.185 122` `#A4C915`, hover `0.830 0.170 122` `#B5D84A`, soft `0.280 0.055 122` `#242D0B`, ink `0.150 0.030 122` `#090D02`. Measured: ink on accent 10.19:1 Lc 67.0, accent on `--bg-0` 10.15:1 Lc 65.6, on `--bg-1` 9.59:1 Lc 65.1, accent on its own tint 7.49:1 Lc 62.0, `--text-1` on that tint 12.47:1 Lc 93.1, ink on the hover 12.04:1 Lc 75.5. Chartreuse passes every pair at least as well as amber, and on a label on the fill it passes better. The decision does not rest on contrast.

   Distance from the accent to every state colour, in OKLab. Amber: error 0.147, revoked 0.171, executed 0.190, vanished 0.197, indexing 0.202, disabled 0.329, and 83 degrees of hue from executed. Chartreuse: executed 0.111, vanished 0.224, indexing 0.229, revoked 0.269, error 0.274, disabled 0.346, and 33 degrees from executed.

   Amber is chosen on the criterion that the accent must stay distinct from every state hue, and it meets that criterion as approved with no lift. It doubles as the awaiting hue, so it has to sit apart from the states it is drawn beside: 83 degrees of hue from executed, against 33 for chartreuse, whose nearest state is executed at 0.111. It is also the approved brand colour, and a colour that has to be lifted to clear a bar is no longer the approved one. Lifting chartreuse does restore the distance, to 0.158 from executed at `0.845 0.204 122` `#B7DF07`, the most chroma that lightness holds in sRGB, but only by leaving the approved lightness.

   A label on the accent fill is the supporting role: Lc 60 at 14px and above at weight 600. `--accent-ink` measures Lc 63.0 at rest and Lc 71.7 on the hover, so the role is met with 3.0 to spare, and the gate declares that pair under the supporting role. It is not the reading role: the most a label can reach on this fill is Lc 64.2 with black ink, so text needing Lc 75 is never placed on the accent. If that changes, lifting the accent to `0.845 0.126 72` `#FFBE6A` measures Lc 75.7 for a black label, at the price of a paler amber, and is recorded here as the remedy rather than taken.
2. Font: Geist Sans, decided by rendering the same screen in both.

   Both faces are legible at 14px and 16px on the ground and both carry working tabular figures: with `font-variant-numeric: tabular-nums` a digit measures 8px at 14px in each, and a string of zeros and a string of ones measure the same, so a column of figures holds its alignment.

   Weights: Geist offers 100 to 900, Instrument Sans 400 to 700. This block uses 400, 500 and 600, which both cover, so the wider range is headroom rather than a reason.

   Pairing decides it. The mono that stays either way is Geist Mono, and Geist Sans comes from the same superfamily, so a row that sets ordinary text beside a hash keeps one skeleton and one weight axis. Instrument Sans has no mono sibling here.

   The one measure in Instrument Sans's favour is recorded, measured on the strings this product actually sets in sans: at 14px it is 0.65 percent narrower on a row of figures and 2.0 percent on a mixed sentence, and at 16px 0.61 percent, while at 13px it is 0.65 percent wider. Hash lines do not move either way, because they are Geist Mono in both options. The percentage moves with the string and the measuring method, between 0.6 and 2.5 percent across six strings, and stays under 3 percent on every one. It does not outweigh the pairing.
3. Light surface: deferred. The trigger has not occurred and the cost is already known, so nothing is rendered. Trigger: a real need after the Week 12 deployment, not before. Cost: a second value for each of the 28 colours in the tables, fewer once the aliases are counted, a second gate pass over all four surfaces on both measures, and a second set of screenshots plus hover and focus checks. Components need no change if they reference tokens only. Until then `color-scheme: dark` stands and no light value is stubbed.
4. Compact rail in list rows: detail only until Week 9. Week 8 rows know only "seen in block N", there is no head and no real row count, and the direction bans fake data and says to decide this with real row counts. It reopens when the Week 9 head read lands and real rows exist. On return it must carry meaning without the head, have a text equivalent, and follow the finality copy (indexed, seen in block N, reversible window; never "confirmed", never "final").

## How this is used

- Tokens land as CSS custom properties. No styling framework, no component library. The TypeScript constant module is deferred, because nothing in this block reads a token from code; it lands with the first thing that does.
- Every component ships default, hover, focus, active, disabled, loading and error, where each applies. Skeleton rather than spinner for content: the restoring screen is a static skeleton, and the spinner belongs to buttons.
- The review pass before any frontend PR sweeps the change against the vendored acceptance checklist and reports findings as `file:line`.
