# Frontend experience brief

Corrected 2026-10-13 against the mentor review of 2026-10-13. Governs navigation, anatomy, loading, interaction, auth composition and phase placement for Weeks 7 to 12.

## 0. Document roles

Two documents, two jobs, cross-linked. An overlapping decision is amended in both before implementation.

- `docs/design/direction.md` governs numeric tokens: colours, the contrast gate, type size steps, spacing, radius, the time-based motion values. Nothing in this brief restates a value from it.
- `docs/design/experience-brief.md` (this document) governs experience decisions: navigation, page anatomy, loading behaviour, interaction model, auth composition and phase placement.
- Where the two touch, the direction wins on the value and this document wins on the behaviour. The auth sequence is the current example: the direction's parked-spine wording is amended by section 13 here, and the direction's type section is superseded by section 4 here.
- Issue #66 carries the block's acceptance criteria and is amended with the same scope cuts.

## 1. State and the restart

What exists:

- B1 merged as PR #65: Vite, React, strict TypeScript, typed API client, auth, routes, protected shell, tests, CI job.
- F1 merged as PR #68: password minimum on register.
- B2 open as issue #66 and draft PR #69 on `feature/design-system`: direction document landed, tokens, the decided self-hosted faces, base layer, primitives with state coverage, the restyled B1 screens, and the guard suite that measures the document and the stylesheet against each other.

The identity restart:

Kept: the API client, auth and session handling, routes, validation, focus management, primitive APIs and state coverage, the token pipeline, the guard suite, tests and CI, the skip link, per-route titles.

Replaced: the typeface, the loading language, the app chrome and navigation, the placeholder page anatomy, the auth composition.

Why: without a fixed identity the frontend converges on the same dark dashboard every generated project ships. The identity is fixed here in writing, once, and screens are built against it. This is a planning restart, not a demolition: nothing restarts on the branch, and both B2 checkpoints build on the reviewed work already there.

## 2. The concept

The register. A multisig is an ordered record of intents, each waiting on signatures, each ending in a block. The interface is a live register, not a dashboard.

Three motifs, all functional:

- The rail: sequence and state. A transaction's life drawn as a line with ticks at the block numbers it touched.
- The row: the record entry. Dense, hairline separated, tabular figures, a state glyph.
- The stamp: execution, and only because a real `ExecuteTransaction` event was indexed.

Feel: a ledger under a lamp. Warm dark ground, amber reserved for waiting, hairline structure, quiet chrome, exactly one authored moment in the app.

Story in one line: every transaction here is a signature waiting to happen, and you can see all of them.

## 3. What we refuse

1. The generated dashboard: KPI cards on top, gradient hero, violet glow on black, glass, identical card grids, a rounded active pill in a sidebar, sparkline decoration.
2. The wallet-clone look: gradient-heavy wallet sites and neon-on-dark, where colour is atmosphere instead of state.
3. Template sections: hero with kicker and two buttons, logo strip, feature grid, testimonial cards, pricing table, FAQ accordion. None of these belong to this product.
4. Inside PR #69: the earlier interim face, the shimmer-slab skeleton, the top bar with placeholder sections, empty states that are a single sentence.

Every refusal is answered concretely in sections 4 to 12.

## 4. Type system

Type is the identity. This section is the most specified one, and it is not yet decided: the lane is approved, the winner is chosen by rendering.

### Lanes from the brands

| Brand | Face | Status |
|---|---|---|
| MetaMask | Euclid Circular B, Swiss Typefaces | Retail. Geometric circular grotesque, warm terminals, tall x-height |
| Uniswap, Unichain | Basel Grotesk, Optimo | Retail. Modernist grotesque with a matching mono in the same programme |
| Polkadot | Unbounded | Open, SIL OFL. Wide geometric display face, an on-chain brand font by construction |
| Most wallet apps | Inter or system UI | The default we are leaving |

### Licensing, which constrains more than taste does

- Euclid Circular B and Basel Grotesk are per-project retail licences. Their files cannot be committed to a public repository, and this one is public.
- Fontshare and ITF families such as Satoshi and General Sans are free to use commercially but their licence restricts redistributing the font files, so self-hosting in a public repo is out.
- Everything committed must be OFL or equivalent permissive, subset and redistributed with its licence file, the same pattern the vendored design references already use.
- The identity therefore comes from open fonts chosen in the brands' lanes, not from their files.

### Decided 2026-10-13: Fraunces, Archivo and Martian Mono

Candidate A won: Fraunces for display, Archivo for the interface, Martian Mono for raw values. Candidate B, Unbounded, was the losing display face and leaves no file, token or rule in the tree.

Why A, in the mentor's words: Fraunces gives the warm ground a printed-record character that fits the register concept, Unbounded's broad shapes pull the screen toward a brand statement, Archivo keeps the controls quiet, and Martian Mono separates raw chain values from interface text.

What the comparison establishes, and what it does not. The two candidates rendered different headline copy, so the line counts in the mobile captures, six lines in A against five in B, are not a wrapping comparison, and an earlier draft of this brief reported them the other way round. The record reads as an identity decision taken from the rendered screen, not as proof that A wins an equal-copy fit test. The loading measurements belong to the same evidence set and do not isolate the display face either.

### Vendoring, landed

`docs/design/NOTICE.md` records source, version, woff2 filenames, axes, subset, sizes, hashes and the OFL notice per family, and the font guards assert that exact set. Vendored bytes total 179,500, which is 70,112 more than candidate B would have cost; the mentor accepted that identity tradeoff and asked that only the critical faces be preloaded rather than all three. The interface and display faces are preloaded, the mono is not. Other guards are not weakened to accommodate any of it.

Fallback metrics are measured and shipped, not estimated: each family has a fallback face whose size-adjust, ascent-override and descent-override were derived from Chromium measurements of the strings this product sets, with the method and the values recorded in the direction document's type section. The display face is set with its axes pinned and optical sizing off, one shape wherever it appears, which is also what lets the fallback correction hold. The delayed-load behaviour is re-measured on the composed auth screen in the screens checkpoint.

### Hard rules

- The display face appears in two places in this checkpoint: page titles and the auth headline. Never in buttons, labels, table headers, data, form fields or inline UI, and not yet as a section opener, because that is a third and much smaller step than the two that were calibrated. The wordmark is set in the interface face until that step is decided by rendering, and the open items carry it.
- Fraunces carries proportional digits and has no `tnum` feature, so a figure is never set in the display face. Figures are the interface face with tabular figures, or the mono when the value is raw.
- Mono only for raw wei, addresses, hashes and block numbers. An amount formatted in ETH is UI sans with tabular figures, as are balances. Mono is not a texture.
- Inputs are at least 16 px.
- `font-variant-numeric: tabular-nums` on every figure that can change, verified per family.
- Self-hosted woff2, Latin subset, no CDN, `font-display: swap`. Fallback metrics are measured and set, and the result is described as measured rather than as a guarantee of zero shift.
- Fixed rem scale from the direction document. It does not change.

## 5. Navigation: the rail as spine

Approved, with the labels always discoverable rather than hover-only, and this block's scope narrowed to what exists. Landed in the screens checkpoint as one list in two shapes: the destinations, their labels and their routes are declared once and the frame renders them as a rail or as a strip.

Desktop, 768 px and above:

- A narrow rail on the left, widened as needed so labels are readable without hover, never relying on a tooltip. Each destination is a tick with its visible label. The active one is marked by shape, and its label is visibly stronger, not hidden behind a pill.
- No top bar, no breadcrumbs. Page titles carry context. Detail pages have one back affordance.
- The rail is the same element on every screen and does not animate between routes.

Destinations by week, so no dead links are ever shipped:

- Week 7: Overview, Contracts, Wallets. These routes exist in the shell and their placeholder screens are honest.
- Transactions arrives in Week 8 with the indexed register.
- Settings arrives when there is something to configure, which is not this block.

Deferred with reasons:

- Waiting count at the top of the rail: not Week 7. It requires connected-owner identity and demonstrably complete scoped data, or it shows a false zero. It returns only when both exist; otherwise it is omitted.
- Command palette: Week 8, limited to existing routes and actions and already loaded entities. It makes no claim of exhaustive global search.

Mobile, below 768 px: the rail collapses to a bottom strip of labelled ticks, thumb reachable, no hamburger drawer. Detail views are full screen with an explicit back. Hit targets 44 px. The strip is fixed over the page, so the frame reserves its height plus the safe-area inset under the content and the root scroller carries the same value as scroll padding: a field or a link reached with the keyboard stops above the strip rather than under it. The same inset is added to the page gutter, for the notch and for a home indicator. Both destination lists are also padded inside their edges, because the focus ring is drawn outside the element it belongs to and a destination flush with a viewport edge would lose part of its ring. In the strip that padding is 8px block and at least 12px inline on each outer side, where the inline floor rises with the device inset rather than falling below it; in the rail it is the page gutter inline, with the rail's own 12px block padding covering its first and last row. Amended 2026-10-14 after the review found the edge destinations reaching the viewport edges. Corrected 2026-10-14: the strip's padding is 8px block with a 12px inline floor, not an undifferentiated 12px at the bottom strip, and the reserve accounting that follows from it counts the strip's 1px top border.

Keyboard: standard tab order; `j` and `k` move within a focused list only, never while typing; Enter opens; Escape closes overlays. Every list action available by keyboard and by touch, never by hover alone.

URL is state: supported pagination, filters and tabs live in query parameters so back and forward work.

Auth pages carry no app chrome.

## 6. Page anatomy

Phase-labelled, because the API constrains what can be shown when. The API exposes contract-scoped canonical events; it has no global transaction queue and no search service.

- Overview, Week 7 shape: an honest placeholder and nothing else. It states what the register will hold and where new work will come from. No hero, no fabricated queue, no KPI row. Week 8 gives it contract-scoped reality.
- Overview, Week 9 shape: an attention view built only where the underlying set is complete, meaning owner identity and full scoped data are known. Until then it is words, not numbers.
- Contracts, Week 8: the register of deployments. Address, chain, start block, and the honest indexing availability state.
- Wallets, Week 8: dense rows, balances with tabular figures, never cards.
- Transaction detail, Week 8: the record sheet for one contract-scoped transaction. The rail on the left, drawn from indexed events for that contract. Beside it the facts the API serves, each labelled with its source. `multisigTxIndex` is called the transaction index, never a nonce, and its uint256 precision is preserved as a string end to end.
- Owner and threshold completeness, balances, block timestamps and head-relative depth arrive in Week 9 with the browser-side reads. Anything not yet known is absent or said in words, never estimated.
- A displayed event block number is an indexed fact about that event. It is not an indexer checkpoint, and nothing draws it as progress.
- Settings: later, quiet, account and session only.
- Auth: the first impression, composed in this block and landed static. One narrow column on the warm ground: the product's name, a short headline in the product's own words, then the form, usable without scrolling at 360 px. The four facts of section 13 follow the form as a plain list, which is both the static composition and the fallback the bounded sequence is drawn on top of. Nothing precedes the form that has to be read, scrolled past or dismissed.

## 7. Loading language

- Under 150 ms: nothing is shown. Content paints.
- 150 ms to 2 s: a skeleton in the exact anatomy of the content. Same rows, columns and hairlines, static fill, no shimmer, no rounded slabs. Anatomy loading is already what the primitives do and it stays.
- Beyond 2 s: a status line that says what is happening in words, plus a retry after an actual failure. Two seconds means slow feedback; it is not treated as an error. Landed in the screens checkpoint for the session check: the restoring screen shows its anatomy at once and the status line becomes visible after two seconds, in the same live region and the same words, with no accent, no warning treatment and no retry, because nothing has failed.
- No spinner in content areas. A spinner appears inside a submit button only, which keeps its label.
- Stale data is retained only for the same user, the same entity and the same query scope. Moving to a different contract, account or query shows anatomy loading rather than the previous entity's data under a new heading. Cross-tab identity changes invalidate caches rather than serving the wrong scope.
- Navigation between already-fetched views swaps in place. Nothing animates on navigation or mount.
- Indexing availability is a first-class state and is worded from the API's three values. An empty event page means the page is empty; it is not presented as proof that indexing is lagging. A row missing from a paginated response is not presented as proof of a canonical removal.

## 8. Interaction model

- Cursor semantics, not cursor art: default, pointer on controls, text selection preserved on every address and hash, copy affordance on hover and focus. No custom cursors.
- Copy feedback is in place: the row shows copied for about 1.2 s. No toast.
- Press: 120 ms depress at 0.98 scale on the recorded easing, row highlight on press, links underline on hover. Row actions are reachable by keyboard and touch, not by hover alone.
- Focus: a visible focus ring on `focus-visible`, trapped in dialogs and returned on close, and the rail is fully keyboard navigable.
- Destructive actions confirm inline, not in a modal.
- Empty states teach: what will appear and the action that creates it, in one or two sentences, no illustration.
- Long values never break layout: middle-ellipsis with the full value on hover and focus. The break-ui conditions, meaning long names, a single item, zero items, huge counts and non-Latin text, are review inputs for data views in Week 8.
- Icons: no new icon set in this block. Active shape plus words carry the rail. A functional SVG or library adoption later needs its own scope and licence approval.

## 9. Motion

Governed by the direction document's values. This section sets behaviour.

- Budgets: press 100 to 160 ms, interaction feedback 150 to 250 ms, state change 200 to 300 ms, overlays 200 to 500 ms only when an overlay exists. Transform and opacity only. Colour changes immediately on state.
- The pattern: one authored data rail inside the app, plus one bounded factual explanation on auth, which is the explicit exception recorded in section 13. Nothing else.
- Micro-feedback allowed: press states, row hover wash, copy confirmation, the submit button keeping its label while showing a spinner, field error reveal, value changes crossing in place.
- Banned: page-load choreography, route entrances, scroll reveals inside the authenticated app, animated masks and `clip-path`, scroll hijacking, parallax, word animation, ambient loops, animated numerals on mount, and any new raw timing that is not one of the recorded tokens.
- Reduced motion neutralizes every moving transition. The auth sequence renders complete and static, the rail renders static, and state stays legible in words rather than only in colour.

Amended 2026-10-14 by the planning verdict. Frontend feel, visual design and animation choices are the author's, and the mentor's review keeps functionality, data and API contracts, security, accessibility and measured performance, not aesthetic preference. The placement and count restrictions above are reopened: the blanket bans on route and mount motion and the fixed count of authored moments no longer bind by themselves. The replacement placement and count rules are recorded in this section, and the guards that hold them are updated in the same commit, before any new motion relies on them. Numeric values still belong in the direction document. Reduced motion, contrast, targets, usable forms, truthful states and measured performance stay binding, and with them the bounded auth fallback in section 13.

Replacement placement and count rules, recorded 2026-10-14 before any effect relies on them:

- Motion is placed in three places and nowhere else: the micro-feedback list above, one scroll-linked factual explanation on the auth facts list in section 13, and the indexed data rail once real rows exist to draw.
- Route and mount entrances stay out although the blanket ban is reopened: a screen arriving is a state change, not an event, and anything a reader sees a hundred times a day does not animate.
- The authored count is bounded to the two named surfaces, the auth explanation and the data rail, and each has to state a fact rather than decorate one.
- Scroll-linked motion runs on a native animation timeline, never on a JavaScript scroll clock, and IntersectionObserver is never a progress clock.
- A scroll-linked sequence is timed linear, because its timeline is scroll rather than time and an eased mapping reads as rubber-banding against the reader's own gesture. This is the second documented exception beside the turning indicator, and the direction document names both.
- Every scroll-linked rule sits inside an `@supports` gate for the timeline and a `prefers-reduced-motion: no-preference` gate, so an unsupported browser and a reduced-motion reader both get the complete static content.

## 10. States matrix

| Surface | Loading | Empty | Failure | Availability |
|---|---|---|---|---|
| Overview, Week 7 | not applicable, static placeholder | states what the register will hold | not applicable | not applicable |
| Overview, Week 8+ | anatomy rows | names what will appear and how work arrives | status line with retry | partial data is labelled partial, never classified as waiting |
| Contracts | anatomy rows | how a deployment gets tracked | status line with retry | indexing, or the worded neutral treatment for disabled and unsupported |
| Wallets | anatomy rows | how a wallet gets added | status line with retry | not applicable |
| Register, Week 8 | anatomy rows | the contract has no indexed events yet, said plainly | status line with retry | an empty page is an empty page, not evidence of lag |
| Record detail, Week 8 | anatomy sheet | not reachable without an id; unknown id gets recovery | status line with retry | indexed through the last event served, stated as such |
| Settings | later block | not applicable | inline error | not applicable |
| Auth | none, the form is the first paint | not applicable | inline field errors, focus to the first | a short line when the API is unreachable, with retry |
| Session check, Week 7 | the restoring screen: anatomy at once, and the status in words past two seconds | not applicable | the unavailable screen names the failed check, the retained local token and the unknown answer, with Retry and Sign out | not applicable |

## 11. Copy and voice

Rules: plain words, controls name the action, errors name the problem and the recovery, no em or en dashes, no emoji, no exclamation marks, no ALL CAPS, no kickers, no section numerals.

One rule about claims, added 2026-10-14 after the review. A screen may state only what it knows. When the session check cannot reach the API, the copy says the check failed, that the token from the last sign in is still stored on this device, and that whether the server still accepts it is unknown. It does not say the session is safe or that nothing was lost, because the retained credential does not prove the server session is still valid: Retry can answer 401, which clears the credential and returns the visitor to sign in. Retry is described as rechecking, Sign out as clearing this device's session.

Vocabulary: waiting on you, waiting on others, indexed, seen in block N, reversible window, executed in block N, not indexed yet, partial history. Never confirmed, never final, never success. Owner approvals and block depth are different facts and are worded differently: approvals count owners, depth counts blocks.

Facts that must stay exact, because an earlier draft of this brief got them wrong:

- Fifteen seconds is the scanner's polling cadence, not a block-to-index delivery guarantee. The indexer deliberately stays behind a safety head and can lag the chain.
- Twelve blocks is a reversible heuristic, not a maximum reorg window.
- Execution requires the configured approval threshold, not every owner.
- `pending` describes indexing availability, not scanner progress.
- Partial history is labelled partial. A missing row in a paginated response proves nothing about the canonical chain.

Numbers: tabular figures, exact wei values through the API as strings, Intl for dates and numbers, relative times updated on a slow tick with no animation.

## 12. Anti-ordinary contract

| Ordinary | What we ship instead | Why |
|---|---|---|
| Inter, system UI, the template default | Fraunces for display, Archivo for the interface, Martian Mono for raw values | The default face is the strongest tell of a generated site |
| Hero with kicker and two buttons | The register states its job in one display line | This is a tool, not a landing page |
| KPI card row | Attention view only where the underlying set is complete, words until then | Cards hide priority, and a number without complete data is a lie |
| Shimmer skeletons and spinners | Anatomy skeletons, status lines, scoped stale data | Loading should describe shape and state, not decorate time |
| Top bar with pills and breadcrumbs | Labelled rail spine, URL as state, palette in Week 8 | Navigation should carry meaning, not chrome |
| Custom cursor or cursor trails | Cursor semantics and in-place copy feedback | Reinventing a standard affordance is a template flourish |
| Card grids everywhere | Hairline rows and record sheets | Density is the point in a multisig tool |
| Illustration empty states | Teaching text with a next action | An empty state is an onboarding step |
| Violet glow on black, mesh gradients | Warm near-black ground, amber reserved for waiting | Colour carries state, not atmosphere |
| Animation on every section | One data rail plus one bounded auth explanation | Motion without a job is debt |
| Emoji and mixed icon sets | Words and active shape in this block, one set later under its own approval | Consistency reads as craft |
| Zebra tables with pill badges | Hairlines and the state glyph | The row is a record, not a widget |
| Centered card on a gradient login | Composed register page, form first | The first impression is type and composition |

## 13. The auth sequence, bounded

Amends the direction document's parked-spine wording and the earlier global one-moment wording. The pattern becomes: one authored data rail inside the app, plus one bounded factual explanation on auth.

What is in the tree now is the static composition: the headline and the form, then the four facts as a list. The sequence is the next step and it is drawn on that list, so a browser without scroll timelines, a reader with reduced motion and the capture machine all get the same four facts in the same order.

Conditions, all binding:

- Amended 2026-10-14 by the planning verdict: the wait for a separate static-screen verdict is withdrawn. Inside the combined completion block the static fixes complete and are locally tested first: the visible restoration words after two seconds with one announcement and timer cleanup after completion and unmount, the honest retained-credential and unknown-validity copy with Retry restoration and Retry-to-401 coverage, and the unavailable state's Sign out explicit as local-only. The bounded enhancement is then implemented on top of them in the same block. The form stays usable without scrolling at 360 px and nothing gates the form.
- Amended 2026-10-14, binding on the sequence: a viewport with no scroll range still shows every fact completely. The sequence must not leave a fact reachable only by scrolling, and it must not turn a fact into something a reader has to scrub past to see. If the composition fits the viewport already, the sequence either does nothing there or shows the facts whole. Amended 2026-10-14 by the consolidated verdict: the sequence's timeline reads the true scrollport, with the zero inset declared inside the timeline function (`view(block 0px)`), and never the root's scroll padding, where the shell's strip reserve and its safe area live, so no reserve can shrink the range in which a fact settles. Both auth routes hold every fact reachable at a zero and at a positive bottom inset, scrolled to the bottom of the reachable range and in a just-fitting viewport with none.
- At most four short facts, and all of them inside at most two added viewports of total height. Not one viewport per fact.
- Transform and opacity only. No animated masks, no `clip-path`, no scroll hijacking, no parallax, no word animation, no loops.
- Mechanics: native CSS scroll timelines as progressive enhancement. IntersectionObserver is not a continuous scroll-progress clock and is not used as one. Browsers without scroll timelines and users with reduced motion get the complete static content, which is the same facts rendered as a list.
- The scroll-timeline mechanics are documented narrowly in the guards without changing the approved time-based token ladder. Press stays 120 ms. Error and value feedback use the recorded feedback tokens or change immediately. No fresh raw timings, no unrecorded stagger.
- The four facts, exact and verified:

  1. Keys stay in your wallet. The server never signs.
  2. Indexing polls every 15 seconds and stays behind its safety head, so indexed history can lag the chain.
  3. Twelve blocks is a reversibility heuristic, not finality.
  4. Execution needs the configured approval threshold, not every owner.

- Evidence: a production frame trace with the device and browser named and the 4x CPU, Slow 4G preset. The 60 fps bar is judged against that setup, not as a universal claim. If the effect cannot meet it, the static composition ships. A motion library is not the fallback. The decision rule, recorded before measuring: on that preset the median frame interval across one full scroll of the facts stays at or under 20ms and the worst single frame at or under 100ms, on a trace that names the browser; a sequence that cannot meet both numbers leaves the tree and the static composition ships. Amended 2026-10-14 by the consolidated verdict: those two numbers are a coarse alarm inside the walk, not the acceptance rule, and they do not replace the 60 fps requirement above, which is judged against the named trace and preset. The walk measures frame intervals while a fact is actually settling inside the reachable scroll range, never on an idle page, and a sequence that trips the alarm still leaves the tree.

At the screens checkpoint the authenticated app ships with no scroll reveals, no route entrances and no ambient motion. That is the shipped state, not a standing ban: section 9 carries the reopened placement rules, and the replacement rules with their guards land before any new motion does.

The enhancement ships inside the combined B2 completion block: findings 2 and 3 plus this sequence as one block, one head, one evidence bundle and one consolidated verdict, carrying finding 1's outstanding regression evidence rather than assuming it closed. The binding conditions above survive the combination: native CSS scroll timelines as progressive enhancement, the four-fact and two-added-viewport limit, the usable form, the complete fallbacks under reduced motion, a missing scroll timeline and no scroll range, and the recorded performance requirement.

## 14. What changes in PR #69, what stays

Stays: the typed client, auth, session, routes, tests, CI job, the token pipeline, the guard suite with values retargeted, the primitive APIs and state coverage, validation, focus management, base styles, anatomy loading, the contrast gate and the acceptance requirements in section 17.

Replaced: the loading language where it decorates rather than describes, the shell and navigation, the placeholder anatomy, the auth composition, and the type tokens, which now carry the decided faces in place of the earlier interim set.

Added in the screens checkpoint: the labelled rail spine with this block's three destinations, the composed auth page with its bounded sequence, honest placeholders, restoring, unavailable and not-found.

Deleted: anything whose only purpose was to look like a standard dashboard.

## 15. Block plan

Two checkpoints per block. Each future block gets its own seven-section issue and one active branch when it starts; this plan does not authorize implementing them inside PR #69.

| Block | Checkpoint 1 | Checkpoint 2 |
|---|---|---|
| Week 7, B2 | Corrected planning docs; rendered type decision; selected fonts and notices; retargeted type and font guards; existing primitives and anatomy loading | Labelled navigation spine; composed auth with the bounded enhancement; honest overview placeholder; restoring, unavailable, not-found. No data views |
| Week 8, indexed register | Consumed API types and calls; TanStack Query; user and entity scoped caches; cross-tab identity safety; URL state for supported pagination, filters and tabs | Wallet and contract records and CRUD; contract-scoped indexed register and record detail; the event rail drawn from real rows; the states matrix; a limited command palette; a break-ui pass |
| Week 9, wallet and chain | Connection, account and chain detection, Sepolia checks; owner, threshold, balance, timestamp and head reads | User-approved approval, revoke and execute controls; chain facts and indexed facts labelled by source; reversible depth; owner-specific attention only where the underlying set is complete |
| Week 10, full flow | Receipt, refresh, cancellation, failure and duplicate-handling seams | Browser action through event, indexer, database, API and interface; indexing delay, reorg and reinclusion, identity-change evidence |
| Week 11, quality | Regression, end-to-end and security coverage; the recorded OpenAPI CI-gate decision | Craft, contrast, keyboard, reduced motion, break-ui, font and bundle review at the throttled profile. No new visual CI gate |
| Week 12, deployment | Same-origin HTTPS, configuration, operational checks, CSP design | Notices, README, architecture and security docs, threat model, limitations, screenshots, an honest demo |

## 16. Resource map

Each layer names its source. The map permits reference and redrawing; it is not blanket permission to copy or install anything.

| Layer | Source | Taken | Shipped |
|---|---|---|---|
| Concept and information model | Safe-wallet queue and owner model; MetaMask Portfolio onboarding | structure and vocabulary | our screens |
| Design governance | Impeccable: craft floor, operate and persuade modes, the 60-rule dataset | rules and review passes | vendored private, applied per screen |
| Motion values | emilkowalski/skills: animate, vocabulary, find opportunities, review, improve, performance cheatsheet | easings, duration bands, technique names, the review table | the direction's three easing tokens and their uses |
| Interaction and forms | emil design engineering, Vercel checklist | press physics, focus, keyboard, form rules | our primitives |
| Component structures and scroll technique | animata (MIT), React Bits and Skiper free pieces as reference | structures, parameters, scroll-linked technique | redrawn in our tokens. A copied file, never a redrawn one, is from animata with its notice |
| Type | Euclid Circular B, Basel Grotesk, Unbounded read as lanes | the lane, never the file | the winning OFL pairing plus Archivo and Martian Mono |
| Colour | our approved ground and accent, Impeccable colourize for ramp sanity | the recorded values | the token set already in review |
| Data narrative | L2Beat, Tenderly, Dune, Linear, Raycast | information architecture and tone | our layouts |
| Loading and states | Impeccable operate rules, the craft floor | skeleton over spinner, teaching empty states | our loading primitives |
| Evidence | chrome-devtools-mcp, established viewports | traces and screenshots | captured on Mayur's machine |

Non-uses, closed: no shadcn or shadcn MCP, no ThreeUI or Animaster effects, no uizze packs, no React Bits dependency, no Fontshare files in the repository, no motion library unless a demonstrated limitation and an approved dependency record state its purpose, version, licence and free-tier status.

## 17. Acceptance requirements carried from B2

Unchanged by this brief, and not to be traded against the new identity bar:

- Contrast gate: the stricter of APCA and WCAG decides, with reading Lc 75 and 4.5:1, supporting Lc 60 and 4.5:1, headings Lc 45 and 3:1, boundaries and focus Lc 30 and 3:1, and disabled text carrying no information. Retarget used pairs and size or weight roles, never the thresholds.
- Hit targets 44x44 px mobile and 24x24 px desktop.
- `touch-action: manipulation` while preserving pan and pinch zoom.
- Not-found recovery to `/`, which is and remains the protected shell.
- Heading `scroll-margin-top`, non-breaking brand spaces.
- React render tracking and a CPU and network throttled production profile.
- Preserved exact password handling and the reviewed two-line sign out at 360 px.
- Amended 2026-10-14 by the planning verdict: the default submission is the CI browser-evidence run and its report link. One browser-evidence job produces one HTML report entry point plus the walk recordings as run artifacts, and the report names the tested SHA, the outcomes, the browser, the viewport and DPR, and fixture versus real-data provenance. A failing run uploads whatever evidence exists and never converts a failure into a pass, and credentials and provider secrets stay out of recordings. If artifact access is blocked for the reviewer, the same bundle is uploaded once with the submission; supplementary evidence is then requested only for a named coverage gap or failure, not to repeat captures the bundle covers. Recordings do not replace frame-timing measurements and do not prove live-API behaviour. Manual captures at the established viewports, with the rendered source SHA and data provenance, remain for what the job cannot cover.
- Browser evidence runs on `@playwright/test` 1.64.0, dev-only, Apache-2.0, for the walks, the report and the recordings, with browser discovery kept separate from Vitest and jsdom. No runtime dependency, no paid reporting service, no screenshot-diff gate and no branch-protection change is authorized.
- A public fixture demo build is deferred as a separate delivery surface and is not approved inside B2. Labelled fixtures remain allowed in isolated tests and specimens.
- The Week 8 design-only specimen batch is approved as one coherent batch, prepared together on contract-shaped labelled fixtures, with no invented capabilities and no unavailable fields. It authorizes no production data view in PR #69, and Week 8 feature implementation still follows B2 acceptance, the merge and post-merge CI.
- Detailed evidence in the chat reply; the PR stays product-focused.
- No public-chain transactions to manufacture activity.

## 18. Open items

- Whether the auth sequence meets its frame budget at 4x CPU, Slow 4G; if not, the static composition ships. The static composition is measured first, so the budget is judged against a floor rather than in the air.
- The display wordmark: a third and much smaller step of the display face than the two that were measured. Decided by rendering when there is a reason to, not by extending the calibration down into interface type.
- The delayed-load re-measurement on the composed auth screen is taken in this checkpoint at 360 px and 1440 px, and it claims only what it shows: wrapping and form position, not a cumulative layout shift improvement.
- Public landing route: cut from the core roadmap. Reconsider after deployment as its own decision, and never by replacing the protected `/`.
- Compact row rails: detail only through Week 8, revisited when Week 9 head reads and real rows exist.
