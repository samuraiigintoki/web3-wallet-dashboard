# Interface checklist

The acceptance checklist is the pinned rule text of `vercel-labs/web-interface-guidelines`
(`AGENTS.md`, 7995 bytes, SHA-256
`35411b4a2dcfa651fd33706a92cc860947364b521643107fbf3116abe3826d44`) at upstream
commit `434b7f91364665f2f733b310ec54809bf8f37937`, MIT, vendored verbatim in the
private agent repository. Every rule in that text is recorded below against the
design system block: pass, not applicable with the reason, or deviation with the
reason. Every MUST deviation carries a reason.

What informed the verdicts: the guard suite in `frontend/guards/` (contrast on
both measures over 43 pairs, colour traceability, gamut, layers, fonts, component
rules, motion), the captured screens at 360px, 1440px and 2560px, a keyboard-only
walk of `/login`, `/register` and the shell, a reduced-motion walk of `/login` and
the shell, and Lighthouse accessibility runs on `/login` and the shell.

## Interactions

### Keyboard

| Rule | Verdict | Note |
|---|---|---|
| MUST: Full keyboard support per WAI-ARIA APG | Pass | Every interactive element is a native input, button or link and takes focus in DOM order; the walks cover all three screens and no control is skipped. |
| MUST: Visible, unobscured focus rings (`:focus-visible`; group with `:focus-within`); sticky/fixed elements never cover focus | Pass | Every focused stop in the walks shows the 2px accent outline with its offset. Nothing is sticky or fixed, so nothing can cover a focused element. |
| MUST: Manage focus (trap, move, return) per APG patterns | Not applicable | The block implements no pattern that traps focus: no dialogs, menus, drawers or composite widgets. The focus move the forms need is implemented (submit moves focus to the first invalid field); a return rule has nothing to bind until a triggering overlay exists. |
| NEVER: `outline: none` without visible focus replacement | Pass | Guard test: `outline: none` or `outline: 0` is allowed only beside a `:focus-visible` replacement. |

### Targets & Input

| Rule | Verdict | Note |
|---|---|---|
| MUST: Hit target ≥24px (mobile ≥44px); if visual <24px, expand hit area | Deviation | Measured: controls and shell targets run 42 to 52px tall and clear 24px everywhere except the inline prose links ("Create one", "Sign in"), which measure 18px tall with no expanded hit area. At 360px the shell nav and skip links measure 42px, just under the 44px mobile bar. The reviewed shapes ship unchanged; hit-area padding for prose links and 2px on the shell links is recorded for the next interaction slice. |
| MUST: Mobile `<input>` font-size ≥16px to prevent iOS zoom | Pass | The base layer holds controls at 1rem (16px) minimum; the captures show the inputs at that step. |
| NEVER: Disable browser zoom (`user-scalable=no`, `maximum-scale=1`) | Pass | The viewport meta is `width=device-width, initial-scale=1.0` only. |
| MUST: `touch-action: manipulation` to prevent double-tap zoom | Deviation | No stylesheet sets `touch-action`. The property is not visible; the fix is one declaration on the interactive elements and is recorded here. |
| SHOULD: Set `-webkit-tap-highlight-color` to match design | Deviation | Not set; the platform default tap highlight applies on touch devices. |

### Forms

| Rule | Verdict | Note |
|---|---|---|
| MUST: Hydration-safe inputs (no lost focus/value) | Not applicable | The application is client-rendered with no server HTML hydration, so there is no hydration pass that can lose focus or value. |
| NEVER: Block paste in `<input>`/`<textarea>` | Pass | No handler intercepts paste; the tests paste long and padded passwords. |
| MUST: Loading buttons show spinner and keep original label | Pass | The pending button shows the spinner beside its unchanged label (primitives tests). |
| MUST: Enter submits focused input; in `<textarea>`, ⌘/Ctrl+Enter submits | Pass | Native form submission; the block has no textarea. |
| MUST: Keep submit enabled until request starts; then disable with spinner | Pass | The button stays enabled while the form is pending its start, then is disabled and marked busy (primitives tests). |
| MUST: Accept free text, validate after, do not block typing | Pass | Fields accept any text; validation runs on submit only. |
| MUST: Allow incomplete form submission to surface validation | Pass | An empty submit surfaces field errors instead of being blocked. |
| MUST: Errors inline next to fields; on submit, focus first error | Pass | The field error sits under its control in a polite live region; submit moves focus to the first invalid field. |
| MUST: `autocomplete` + meaningful `name`; correct `type` and `inputmode` | Pass | Every field carries `autocomplete` (`email`, `current-password`, `new-password`), a `name` and the correct `type`. `inputmode` is deliberately unset: it would be wrong on `type=password` and is redundant on `type=email`. |
| SHOULD: Disable spellcheck for emails/codes/usernames | Pass | `TextField` sets `spellcheck=false` for `type="email"` (tested). |
| SHOULD: Placeholders end with `…` and show example pattern | Not applicable | The forms carry no placeholders; labels and the password hint do that work. |
| MUST: Warn on unsaved changes before navigation | Not applicable | The block has no editing surface; the auth forms hold no saved work. The rule binds with the Week 8 edit workflows. |
| MUST: Compatible with password managers & 2FA; allow pasting codes | Pass | Standard form controls with password `autocomplete` values, pasting unrestricted. The API has no second factor yet, so no code field exists. |
| MUST: Trim values to handle text expansion trailing spaces | Deviation | The standing deviation of this block: the password is sent exactly as typed, because the server hashes and compares it as received (direction record D9); trimming would diverge from the server rule and lock out edge-space passwords. The email value is trimmed on submit. |
| MUST: No dead zones on checkboxes/radios; label+control share one hit target | Not applicable | The block has no checkbox or radio. |

### State & Navigation

| Rule | Verdict | Note |
|---|---|---|
| MUST: URL reflects state (deep-link filters/tabs/pagination/expanded panels) | Pass | The only navigable state is the section, and each section is its own route. No filter, tab or pagination state exists in the block. |
| MUST: Back/Forward restores scroll position | Not applicable | Measured in the captures: the block's screens fit the viewport without scrolling at 360px and 1440px, so no scroll position exists to restore. The rule binds with the Week 8 data views. |
| MUST: Links use `<a>`/`<Link>` for navigation (support Cmd/Ctrl/middle-click) | Pass | React Router `Link` and `NavLink` only. |
| NEVER: Use `<div onClick>` for navigation | Pass | No click handlers on non-interactive elements exist. |

### Feedback

| Rule | Verdict | Note |
|---|---|---|
| SHOULD: Optimistic UI; reconcile on response; on failure rollback or offer Undo | Not applicable | No list mutation or reversible edit exists. Sign-out resolves locally by design and announces a failed server call rather than optimistically showing success. |
| MUST: Confirm destructive actions or provide Undo window | Not applicable | No destructive action exists in the block; signing out is reversed by signing in again. |
| MUST: Use polite `aria-live` for toasts/inline validation | Pass | Field errors render in `role="status"`; a failure the fields cannot explain uses `role="alert"` (`Notice`). |
| SHOULD: Ellipsis (`…`) for options opening follow-ups and loading states | Not applicable | No menu or follow-up option list exists in the block. |

### Touch & Drag

| Rule | Verdict | Note |
|---|---|---|
| MUST: Generous targets, clear affordances; avoid finicky interactions | Deviation | Same measurements as the hit-target rule: the 18px prose links and the 42px mobile shell links are the recorded shortfall. Everything else measures generously (44 to 52px controls at 360px). |
| MUST: Delay first tooltip; subsequent peers instant | Not applicable | No tooltips exist. |
| MUST: `overscroll-behavior: contain` in modals/drawers | Not applicable | No modal or drawer exists. |
| SHOULD: When suppressing page rubber-band bounce, set `overscroll-behavior: none` on `<html>` inside `@media (pointer: fine)` | Not applicable | The application never suppresses rubber-band bounce, so the condition does not arise. |
| MUST: During drag, disable text selection and set `inert` on dragged elements | Not applicable | No drag interaction exists. |
| MUST: Drag/swipe/pinch/path gestures have a tap/click and keyboard alternative unless essential | Not applicable | No gesture interaction exists. |
| MUST: If it looks clickable, it must be clickable | Pass | Only buttons and links carry interactive styling; fields look like fields. |

### Autofocus

| Rule | Verdict | Note |
|---|---|---|
| SHOULD: Autofocus on desktop with single primary input; rarely on mobile | Not applicable | No form in the block has a single primary input (sign-in has two fields, register three), and the auth surface is deliberately quiet. |

## Animation

| Rule | Verdict | Note |
|---|---|---|
| MUST: Honor `prefers-reduced-motion` (provide reduced variant or disable) | Pass | Measured under `reduce`: `document.getAnimations()` is empty on `/login` and the shell, the shell entrance computes to `animation-name: none`, and the button press to `transition: none`. Guard tests pin the rules. |
| SHOULD: Prefer CSS > Web Animations API > JS libraries | Pass | All motion is CSS keyframes and transitions. |
| MUST: Animate compositor-friendly props (`transform`, `opacity`) only | Pass | Guard: keyframe declarations may set only `transform` and `opacity`. |
| NEVER: Animate layout props (`top`, `left`, `width`, `height`) | Pass | Same guard. |
| NEVER: `transition: all`, list properties explicitly | Pass | Guard test. |
| SHOULD: Animate only to clarify cause/effect or add deliberate delight | Pass | Two motions exist: the working spinner and the single authored 240ms shell entrance the direction records. |
| SHOULD: Choose easing to match the change (size/distance/trigger) | Pass | Only the direction's easing tokens appear, with the recorded `linear` exception for the turning spinner (guard). |
| MUST: Animations interruptible and input-driven; autoplay only for muted, non-essential loops | Pass | The only loop is the working spinner, a non-essential busy indicator whose request ends it; the entrance is one 240ms run. No ambient motion autoplays. |
| MUST: Autoplay motion >5s alongside other content has pause, stop, or hide controls | Not applicable | No ambient or decorative loop exists; the spinner is bound to a request and becomes a static mark under reduced motion. |
| MUST: Correct `transform-origin` (motion starts where it physically should) | Pass | The spinner ring turns about its own centre, where it physically turns; the entrance translates along the block axis only. |
| MUST: SVG transforms on `<g>` wrapper with `transform-box: fill-box` | Not applicable | The block ships no SVG; the direction bans glyph icons. |

## Layout

| Rule | Verdict | Note |
|---|---|---|
| SHOULD: Optical alignment; adjust ±1px when perception beats geometry | Pass | Reviewed on the captured screens at 360px, 1440px and 2560px. |
| MUST: Deliberate alignment to grid/baseline/edges, no accidental placement | Pass | The rem spacing scale and the content column carry alignment; nothing floats off the measure in the captures. |
| SHOULD: Balance icon/text lockups (weight/size/spacing/color) | Not applicable | No icons exist and none are planned for this block. |
| MUST: Verify mobile, laptop, ultra-wide (simulate ultra-wide at 50% zoom) | Pass | Captured and reviewed at 360px, 1440px and 2560px, the 50%-zoom ultra-wide equivalent. |
| MUST: Respect safe areas (`env(safe-area-inset-*)`) | Not applicable | Nothing is fixed, full-bleed or edge-to-edge; content sits in a padded flow column under the browser's own viewport insets. The rule binds if a fixed bar or full-bleed surface is added. |
| MUST: Avoid unwanted scrollbars; fix overflows | Pass | The captures show no horizontal or unexpected scrollbar at any of the three widths; long values wrap. |
| SHOULD: Flex/grid over JS measurement for layout | Pass | Layout is CSS flex and grid only. |

## Content & Accessibility

| Rule | Verdict | Note |
|---|---|---|
| SHOULD: Inline help first; tooltips last resort | Pass | The password bounds are a permanent inline hint; no tooltips exist. |
| MUST: Skeletons mirror final content to avoid layout shift | Pass | The restoring skeleton is a title block plus body lines in the page it lands in, `aria-hidden`, with the status text in a live region. |
| MUST: `<title>` matches current context | Pass | Each route sets `document.title`; the primitives tests pin the titles. |
| MUST: No dead ends; always offer next step/recovery | Deviation | The not-found screen states the mismatch in words but offers no onward control. The unavailable screen (Retry, Sign out) and the auth pair (cross links) pass. A recovery link on not-found is recorded for the next interaction slice. |
| MUST: Design empty/sparse/dense/error states | Pass | Empty (teaching placeholder copy), sparse (overview), loading (restoring skeleton) and error (field errors, form alert, the unavailable screen) are designed and shipped; the dense state is specified in the direction and arrives with the Week 8 data views. |
| SHOULD: Curly quotes; avoid widows/orphans (`text-wrap: balance`) | Deviation | Interface copy carries no quote characters, so the curly-quote half has nothing to bind; `text-wrap: balance` is set nowhere. No harmful widow appears in the captures. |
| MUST: `font-variant-numeric: tabular-nums` for number comparisons | Pass | Set once in the base layer; every figure inherits it. |
| MUST: Redundant status cues (not color-only); icons have text labels | Pass | The invalid field carries a written error beside the error border; the open nav item carries an underline and `aria-current`; states are named in words. |
| MUST: Accessible names exist even when visuals omit labels | Pass | The walks show a name on every focusable; the skeleton shape is `aria-hidden` with its status spelled out. |
| MUST: Use `…` character (not `...`) | Not applicable | No ellipsis appears in the interface copy; the rule binds its first use. |
| MUST: `scroll-margin-top` on headings; "Skip to content" link; hierarchical `<h1>`–`<h6>` | Deviation | Two of the three parts pass: the skip link is the shell's first tab stop and lands on a focusable `main`, and every page has exactly one `h1` with no skipped levels. `scroll-margin-top` is not set on headings. Nothing sticky, fixed or positioned can obscure a scrolled-to destination today; the margin applies when one appears. |
| MUST: Resilient to user-generated content (short/avg/very long) | Pass | Long values wrap rather than clip; the long identity in the 360px shell capture is the visible case, and the primitives tests exercise long strings. Week 8 rows re-run the worst-case pass. |
| MUST: Locale-aware dates/times/numbers (`Intl.*`) | Not applicable | The block renders no date, time or number; the Week 8 data views must use `Intl`. |
| SHOULD: `translate="no"` on brand names, code tokens, & identifiers | Deviation | No `translate` attribute is set on the product name or the identity value. |
| MUST: Accurate `aria-label`; decorative elements `aria-hidden` | Pass | The only `aria-hidden` content is the decorative skeleton shape; no inaccurate label exists. |
| MUST: Icon-only buttons have descriptive `aria-label` | Not applicable | No icon-only button exists. |
| MUST: Prefer native semantics (`button`, `a`, `label`, `table`) before ARIA | Pass | Native elements throughout; ARIA is limited to the states the design needs (`aria-invalid`, `aria-describedby`, `aria-current`, `role=status/alert`). |
| MUST: Media has captions/transcripts/descriptions; decorative media hidden | Not applicable | No media exists. |
| MUST: Non-breaking spaces: `10&nbsp;MB`, `⌘&nbsp;K`, brand names | Deviation | The product name is plain text without non-breaking spaces; it holds on one line at 360px today but is unprotected on narrower displays. No unit or shortcut string exists yet, so the examples bind at their first use. |

## Content Handling

| Rule | Verdict | Note |
|---|---|---|
| MUST: Text containers handle long content (`truncate`, `line-clamp-*`, `break-words`) | Pass | Flex and wrapping containers; the long identity wraps in the shell bar at 360px instead of clipping. |
| MUST: Flex children need `min-w-0` to allow truncation | Not applicable | Nothing truncates; long values wrap instead. |
| MUST: Handle empty states, no broken UI for empty strings/arrays | Not applicable | The block renders no list, count or dynamic string that can be empty; the empty state for data views is the placeholder copy and Week 8 re-runs this rule. |

## Performance

| Rule | Verdict | Note |
|---|---|---|
| SHOULD: Test iOS Low Power Mode and macOS Safari | Deviation | Not run; the harness is Chromium on Linux. |
| MUST: Measure reliably (disable extensions that skew runtime) | Pass | The runs are headless Chromium and Lighthouse with no extensions installed. |
| MUST: Track and minimize re-renders (React DevTools/React Scan) | Deviation | Not instrumented in this block; the tree is small controlled forms. The measurement lands with the Week 8 data views. |
| MUST: Profile with CPU/network throttling | Deviation | No dedicated throttling profile was run; Lighthouse used its default mobile throttling, which is an audit, not a profile. |
| MUST: Batch layout reads/writes; avoid reflows/repaints | Pass | Layout is declarative CSS; the code performs no imperative layout reads or writes to batch. |
| MUST: Mutations (`POST`/`PATCH`/`DELETE`) target <500ms | Not applicable | The block performs no list mutation; the auth calls are network round trips whose latency is the network's. |
| SHOULD: Prefer uncontrolled inputs; controlled inputs cheap per keystroke | Deviation | The forms are controlled inputs so submit-time validation reads one state. Each keystroke re-renders one small form, which the rule counts as cheap, but the preference for uncontrolled is not followed. |
| MUST: Virtualize large lists (>50 items) | Not applicable | No list exists. |
| MUST: Preload above-fold images; lazy-load the rest | Not applicable | No images exist; font preload is judged below. |
| MUST: Prevent CLS (explicit image dimensions) | Not applicable | No images exist; the skeleton holds the restoring layout so nothing shifts when the session answer lands. |
| SHOULD: `<link rel="preconnect">` for CDN domains | Not applicable | No CDN or second origin exists; the build is same-origin only. |
| SHOULD: Critical fonts: `<link rel="preload" as="font">` with `font-display: swap` | Pass | The critical sans file is preloaded from `index.html` with `crossorigin` and matches the hashed asset the stylesheet requests (guard); both faces use `font-display: swap`. |
| SHOULD: `<video autoplay muted loop playsinline>` over animated GIF | Not applicable | No video or GIF exists. |
| SHOULD: Short loops include Safari H.264 MP4, reduced-motion condition, still fallback | Not applicable | No video loop exists. |

## Dark Mode & Theming

| Rule | Verdict | Note |
|---|---|---|
| MUST: `color-scheme: dark` on `<html>` for dark themes | Pass | Set on `:root` and in a `color-scheme` meta; guards hold both to the direction. |
| SHOULD: `<meta name="theme-color">` matches page background | Pass | The guard asserts exact equality with the ground token's sRGB value. |
| MUST: Native `<select>`: explicit `background-color` and `color` (Windows fix) | Not applicable | No native select exists. |

## Hydration

| Rule | Verdict | Note |
|---|---|---|
| MUST: Inputs with `value` need `onChange` (or use `defaultValue`) | Pass | Every controlled input carries `onChange`; the primitives tests pin it. |
| SHOULD: Guard date/time rendering against hydration mismatch | Not applicable | Client-rendered with no date or time rendering. |

## Design

| Rule | Verdict | Note |
|---|---|---|
| SHOULD: Layered shadows (ambient + direct) | Not applicable | Nothing casts a shadow in this palette; depth is surface steps and borders, and the direction defers its overlay shadow token. |
| SHOULD: Crisp edges via semi-transparent borders + shadows | Deviation | Edges use the solid line tokens the direction pins, not semi-transparent borders with shadows. |
| SHOULD: Nested radii: child ≤ parent; concentric | Pass | `--radius-control` (0.625rem) sits inside `--radius-panel` (0.875rem); the pill radius is used only for the circular spinner. |
| SHOULD: Hue consistency: tint borders/shadows/text toward bg hue | Pass | The palette holds hue 75 from the ground through the lines, text and tints. |
| MUST: Accessible charts (color-blind-friendly palettes) | Not applicable | No chart exists; the Week 10 data views bring them. |
| MUST: Meet contrast, prefer APCA over WCAG 2 | Pass | The gate measures every pair on APCA and WCAG and enforces the stricter of the two; all 43 pairs clear their roles. |
| MUST: Increase contrast on `:hover`/`:active`/`:focus` | Pass | The accent hover and press tokens raise the fill, the field border lifts to `--text-2` on hover, and the focus ring is the accent at Lc 60.9 or better on every surface (gate rows). |
| SHOULD: Match browser UI to bg | Pass | `color-scheme` and `theme-color` hand the browser the ground value. |
| SHOULD: Avoid dark color gradient banding (use background images when needed) | Not applicable | The direction bans gradients and the guard enforces their absence. |

## Deviations in one list

MUST deviations, each with its reason above: hit targets (the 18px prose links and
the 42px mobile shell links), `touch-action: manipulation` unset, the password
trim rule (the standing D9 deviation), the missing not-found recovery link,
`scroll-margin-top` on headings, and non-breaking spaces in the brand name.
Process checks not run in this block: re-render tracking, a dedicated throttled
profile, and iOS Low Power Mode and Safari passes. SHOULD deviations: tap
highlight colour, `text-wrap: balance`, `translate="no"`, uncontrolled inputs, and
semi-transparent border edges.
