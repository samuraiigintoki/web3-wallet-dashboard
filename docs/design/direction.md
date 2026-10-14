# Design direction

Approved 2026-10-06. Lands at `docs/design/direction.md` in the product repository when the design system block opens, and that landing is what lifts the frontend freeze. The design system block is scoped from this document. It does not change Week 7 B1.

Two documents carry the design record and they do not overlap. This one governs numeric tokens: colours, the contrast gate, type size steps, spacing, radius and the time-based motion values. `docs/design/experience-brief.md` governs the experience decisions: navigation, page anatomy, loading behaviour, interaction, auth composition and phase placement. Where the two touch, this document wins on the value and the brief wins on the behaviour, and an overlapping decision is amended in both before it is implemented.

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
| awaiting confirmations | `--state-awaiting` | `0.780 0.150 72` | `#F2A635` | `--accent-soft` `0.280 0.050 72` `#382409` | included in a block, owner approvals arriving toward the count the wallet requires; the reversible window is block depth and is counted separately |
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

Three OFL faces, self-hosted, subset: a display face, an interface face and a mono for raw values.

Decided 2026-10-13: Fraunces for display, Archivo for the interface, Martian Mono for raw chain values. The mentor selected candidate A from four rendered captures at 360px and 1440px, on the register concept: Fraunces gives the warm ground a printed-record character, Archivo keeps the controls quiet, and Martian Mono separates raw chain values from interface text.

What the comparison does and does not prove, recorded plainly: the two candidates rendered different headline copy, so the line counts in the captures, six lines in A and five in B, are not a wrapping comparison. The selection is an identity decision from the rendered screen, not proof that A wins an equal-copy fit test. The loading measurements belong to the same evidence and do not isolate the display face either.

Roles, and they are not interchangeable:

- `Fraunces` display only: the wordmark, page titles, the auth headline and section openers. Never in buttons, labels, table headers, data, form fields or inline interface. Fraunces carries proportional digits and no `tnum` feature, so a figure set in it cannot hold a column: figures are Archivo with tabular figures, or Martian Mono when the value is raw. One shape everywhere it appears, which in this checkpoint is two rules: the page heading and the auth headline, and no third. The wordmark is set in the interface face for now, because a display face at 16px is a much smaller step than the two that were calibrated and a substantially smaller display use is a decision to take through rendering rather than by extending these numbers; it is carried in the open items rather than dropped. A display rule sets the family and the pin together: `font-optical-sizing: none` with `font-variation-settings: 'opsz' 144, 'SOFT' 40, 'WONK' 1`, the values the approved specimen rendered. Pinning the axes also keeps the metric-adjusted fallback honest, because a face that changes width with the size it is set at cannot be corrected at fallback time.
- `Archivo` for the interface, weights 400, 500 and 600.
- `Martian Mono` for addresses, transaction hashes, block numbers and raw wei strings, and for nothing else. Mono is not a costume for technical. An amount formatted in ETH is the interface face with tabular figures, as are balances: mono is for the raw values, not for every number on the screen.
- Fixed rem scale, ratio about 1.2: 12 meta, 13 labels, 14 body, 16 lead, 19 section, 23 panel title, 28 page title. Auth headline may reach 40, app surfaces do not.
- Tabular numerals on every figure, always. No fluid clamp sizing in the app. Inputs stay at 16px or above.
- Line height 1.5 body, 1.25 headings. Body measure 65 to 75ch in prose, tables may run denser.

Family tokens, with each family's metric-adjusted fallback named before the local families:

`--font-display: "Fraunces", "Fraunces Fallback", "Times New Roman", Times, serif`
`--font-sans: "Archivo", "Archivo Fallback", Arial, Helvetica, sans-serif`
`--font-mono: "Martian Mono", "Martian Mono Fallback", "Courier New", Courier, monospace`

Fallback metrics, measured rather than estimated, on the shipped stylesheet and the shipped font files. The browser reports the advance width of the strings this product sets, at the size it sets them, once with the vendored face and once with the local face named in that face's chain; `size-adjust` is the width ratio in the middle of that set and the ascent and descent overrides restore the vendored box after it. The first pass measured every family at 100px and produced values that do not survive their own use: Fraunces is optically sized, so at the sizes the app sets it, the same strings ranged 98.0% to 118.2% against Times New Roman metrics, and one size-adjust cannot correct a face whose shape depends on its size. The display axes are therefore pinned, and the values below are re-derived at 40px and 28px, the two steps the face is used at: 92.6% to 99.8%, median 95.50% shipped. Archivo is measured at 14px and 16px across prose, labels and figures: 98.2% to 105.0%, median 99.40% shipped. Martian Mono is measured at 12px and 13px: 111.1% and 115.4%, 112.00% shipped, which is 1% off at 12px and 3% off at 13px and is the largest residual in the set, on raw values whose width the layout does not depend on. Shipped: Fraunces 95.50% / 102.62% / 27.23%, Archivo 99.40% / 88.53% / 21.13%, Martian Mono 112.00% / 89.29% / 17.86%, `line-gap-override: 0%` throughout, so the fallback line box is decided by those two values. Liberation Serif, Liberation Sans and Liberation Mono are what the three local names resolve to in the measuring environment; each chain names metric-compatible families so the correction survives a platform that resolves different local files. The values are calibrated to the local faces those chains resolve to in the measuring environment; that is not a claim about every platform. A machine that resolves different local files gets the same method applied to different numbers, and the guard holds the declared values and the face they sit on, not a universal width.

Verification after the swap, on the shipped stylesheet and the shipped files, with each face activated before it is measured. At the auth headline step the fallback stands 1.9% wide of Fraunces with the correction and 5.8% wide without it; at the page title step 0.7% against 1.5%; at 32px, between the two calibrated steps, 5.7% against 6.8%. The raw-value role is exact with the correction at both 12px and 13px, and 10% and 13% narrow without it. The interface face is a wash at these sizes, 1.7% to 2.3% with the correction against 0.6% to 1.9% without, so on that role the correction buys the box rather than the width, for the places where line height is left to the font. Line counts hold through the swap in every role and at every step measured, and that is what a width difference can actually move. On the built `/login` with the font responses delayed 1500 ms, cumulative layout shift measures 0.000012 with the overrides in place and 0 without them. That is not an improvement and is not read as one: the heading box is pinned by its line height either way, so at these sizes the geometry is stable and a swap can only move the page through a width-driven rewrap. The line counts above are what the correction is claimed for, and the shift number is recorded only to say that nothing else moved.

Preload policy: the two faces the first paint needs are preloaded, the interface face and the display face. Martian Mono is not preloaded, because a screen may never render a raw value; it loads when one does. Vendored bytes total 179,500, which is 70,112 more than candidate B would have cost; the identity tradeoff is accepted and recorded here.

Before vendoring, the record carries source, version, axes, subset, sizes and hashes, and the OFL notice per family: `docs/design/NOTICE.md`. The lane, the licensing reasoning and the judging criteria are in `docs/design/experience-brief.md` section 4. The earlier Geist record remains below as history only: no Geist file, token or rule is in the tree.

## Type history (superseded)

One family plus one mono was the first record. `Geist Sans` for everything with `Geist Mono` for raw values, weights 400, 500 and 600; the `Instrument Sans` swap was rendered beside it and declined on pairing. Its family tokens named Geist Sans and Geist Mono, each with a system fallback. None of it is in the tree.

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

`linear` is the one curve outside those three, and it is allowed in exactly two places, each named here. The first is a continuously turning working indicator, where constant angular velocity is what makes it read as work rather than as a stutter; an eased rotation accelerates and slows every turn, which looks like the interface is struggling. The second, recorded 2026-10-14, is the scroll-linked auth explanation, whose timeline is scroll rather than time, so an eased mapping would read as rubber-banding against the reader's own gesture. Nothing else uses `linear`: a transition, a settle or any other animation that moves on screen takes one of the three tokens above.

Durations, named: `--duration-press: 120ms`, `--duration-feedback: 180ms` for hover and feedback, `--duration-state: 240ms`, `--duration-settle: 320ms`, and `--duration-ceiling: 480ms` for overlays, used only when an overlay exists. The budgets these sit inside: press 100 to 160ms, state feedback 150 to 250ms, overlays 200 to 500ms. Transform and opacity only, on the easing tokens above. Colour feedback may change immediately, or settle inside the state feedback budget; it never drives layout. Never `transition: all`, never `ease-in` on UI, never `scale(0)`. No motion runs on navigation or on mount: a screen arriving is not an event. Anything a user sees a hundred times a day does not animate. Every transition that moves more than a few pixels respects `prefers-reduced-motion`.

### The authored moments, bounded

The pattern, amended 2026-10-13 and reopened 2026-10-14: one bounded factual explanation on auth, drawn on the facts list by a native scroll timeline (`docs/design/experience-brief.md` sections 9 and 13), and one authored data rail inside the app once real indexed rows exist to draw it. The count is bounded to those two surfaces, and each has to state a fact rather than decorate one. Nothing else is a moment.

Reserved, not built. This is the product's one authored moment and it stays reserved until real indexed data exists to draw. B2 renders none of it: a static rail drawing indexed rows is a data view and belongs to Week 8 with real rows. The API exposes no head, checkpoint or lag, so nothing draws a progress meter toward the reversible window and no mock timeline substitutes for the rail. When Week 9's browser-side head exists, the remaining window may show as a count, always described as reversible.

Where: the transaction detail header, with a compact variant in transaction list rows.

What it shows, week by week, using only real data:

- Every tick is an indexed event's block number. Gaps are drawn to scale, so a slow block gap is visible. Nothing is interpolated or faked.
- Week 8, indexed facts only: on first data, ticks render statically; ticks that arrive later settle in over 240ms, opacity and 4px translate, staggered by 40ms, at most three at a time.
- Week 9, adds the browser-side read: the remaining reversible window shows as empty slots with a count, and the newest block is marked. Head never comes from the backend.
- Copy is exact: `indexed`, `seen in block 5,412,300`, `3 of 12 reversible window`, `executed in block 5,412,340`, `indexing` while no row exists. Never `confirmed`, never `final`, never a countdown, never confetti.
- Owner approvals and block depth are different facts and are worded differently: approvals count owners (`2 of 3 owner approvals`), depth counts blocks (`seen in block 5,412,300`, `3 of 12 reversible window`). A row missing from a paginated response is not proof that it was reorged out; reorg language needs evidence the indexer does not serve yet.
- Reduced motion: a static rail, numbers update in place.

### Auth surfaces

One column on the ground, form first. Amended 2026-10-14 by the review: the headline and the form come first, the four facts follow the form as a plain list, and nothing has to be read, scrolled past or dismissed before the form. The static composition ships first and stands alone: with no enhancement applied the list carries the whole explanation, in order, in the product's own words.

The facts run as a bounded sequence on top of that list when it lands. One condition is added to the block below: where the composition has no scroll range, every fact is still shown completely, so a short viewport never turns a fact into something to scrub for. It is the product's only scroll-driven moment, built on native CSS scroll timelines and nothing else. Conditions, all binding, in `docs/design/experience-brief.md` section 13: the form stays usable without scrolling at 360px, at most four facts sit inside at most two added viewports, transform and opacity only, no animated masks and no clip-path, a complete static fallback for reduced motion and for browsers without scroll timelines, and a production frame trace at 4x CPU and Slow 4G. If the effect cannot meet its budget, the static composition ships as it is and no motion library substitutes. No motion runs on navigation or mount.

No WebGL, no 3D, no illustration, no mesh background, no scroll cue, no "scroll to explore". The headline is short, in the product's own words and true: signing in reads a record, it does not hold a key or move a value.

### Auth to app

No motion. The 240ms continuity transition that was recorded here is removed: the no-motion-on-navigation rule excludes a mount animation, and a screen arriving is not an event. The authored moment stays reserved for the real rail.

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
2. Font: Fraunces with Archivo and Martian Mono, selected by the mentor from four rendered captures at 360px and 1440px. Unbounded was the losing display face and leaves no file, token or rule. The caveat is recorded with the section above: the candidates carried different headline copy, so this is an identity decision, not a wrapping comparison. The earlier interim round is retained below as history.

   The two working faces carry tabular figures; the display face does not. Archivo and Martian Mono each set a column of digits that holds its alignment, and they are what a figure is set in. Fraunces carries proportional digits and has no `tnum` feature in its table at all, so a figure is never set in the display face and nothing asks it for one.

   Weights: this block uses 400, 500 and 600. The vendored builds cover 100 to 900 for Fraunces and Archivo and 100 to 800 for Martian Mono, so the range is headroom rather than a reason. Fraunces carries three axes, `opsz`, `SOFT` and `WONK`; the other two carry a weight axis each, which is all they are asked for.

   The pairing is the criterion and the review settled it: a display face with a printed-record character, an interface face quiet enough for controls, and a mono that separates raw chain values from interface text without being worn as a costume. Unbounded was rejected in the same review for the opposite reason, broad shapes pulling a screen toward a brand statement.

   Bytes: the three files total 179,500, which is 70,112 more than candidate B would have cost. The mentor accepted that tradeoff with the preload narrowed to the two faces the first paint needs.

3. Light surface: deferred. The trigger has not occurred and the cost is already known, so nothing is rendered. Trigger: a real need after the Week 12 deployment, not before. Cost: a second value for each of the 28 colours in the tables, fewer once the aliases are counted, a second gate pass over all four surfaces on both measures, and a second set of screenshots plus hover and focus checks. Components need no change if they reference tokens only. Until then `color-scheme: dark` stands and no light value is stubbed.
4. Compact rail in list rows: detail only until Week 9. Week 8 rows know only "seen in block N", there is no head and no real row count, and the direction bans fake data and says to decide this with real row counts. It reopens when the Week 9 head read lands and real rows exist. On return it must carry meaning without the head, have a text equivalent, and follow the finality copy (indexed, seen in block N, reversible window; never "confirmed", never "final").

## How this is used

- Tokens land as CSS custom properties. No styling framework, no component library. The TypeScript constant module is deferred, because nothing in this block reads a token from code; it lands with the first thing that does.
- Every component ships default, hover, focus, active, disabled, loading and error, where each applies. Skeleton rather than spinner for content: the restoring screen is a static skeleton, and the spinner belongs to buttons.
- The review pass before any frontend PR sweeps the change against the vendored acceptance checklist and reports findings as `file:line`.
