# Deployment

How this repository is deployed to staging, how to roll it back, and what the
staging environment does not promise.

Staging is a portfolio and demonstration environment. It is not a production
security or uptime commitment, and it deploys no contract: the Sepolia multisig
verified in earlier weeks stays the testnet deployment the dashboard reads.

## The environment

| Piece | Host | Plan | Notes |
| --- | --- | --- | --- |
| Dashboard | Render static site | free, no expiry, no compute plan to size | React bundle on a CDN, SPA rewrite to `index.html` |
| API | Render web service, Docker | free | sleeps after 15 minutes idle, about a minute to wake |
| Database | Neon Postgres | free, no expiry | 1 GB, 0.25 to 2 CU autoscaling, scale to zero after 5 minutes, in `aws-ap-southeast-1` |

Everything here is on a zero-cost tier. That constrains three decisions:

- **Migrations run at container start, by default.** Render's `preDeployCommand`
  is a paid feature and the Blueprint rejects it on a free service, so the image's
  own `CMD` is `backend/scripts/docker-start.sh`, which runs `migrate up` and then
  `exec`s the API. Migrating is the default when `RUN_MIGRATIONS` says nothing:
  readiness only proves the database answers, so a container that skipped
  migrations would report healthy against an old schema. Only the explicit value
  `off` skips it, and any other value exits 2 without starting anything. If the migration fails the container
  exits non-zero, the deploy is not promoted and the previous instance keeps
  serving. The migrations have to be idempotent and safe to re-run, which the
  advisory lock in `backend/cmd/migrate` guarantees for concurrent starts.
- **The database is Neon, not Render Postgres.** Render's free Postgres expires
  30 days after creation and is deleted 14 days later. Neon's free plan has no
  time limit, and its paid tier is a per-project upgrade rather than a rebuild,
  so the schema and the connection string outlive the free tier if usage grows.
- **The API sleeps.** A cold request after 15 idle minutes pays roughly a minute
  of startup, which includes the migration check. The dashboard shows its own
  loading state while that happens. Nothing in the app depends on the API being
  warm, so this is a latency cost, not a correctness one.

The two live hostnames are:

- Dashboard: `https://web3-wallet-dashboard-c4ii.onrender.com`
- API: `https://web3-wallet-api.onrender.com`

The dashboard carries a suffix because Render appends one when the name is
already taken on `onrender.com`. Both are provider defaults, chosen because they
are readable and cost nothing. They are also named in two places that no
compiler compares:
the dashboard's `VITE_API_BASE_URL` and the API's `CORS_ALLOWED_ORIGINS`.
`backend/internal/deploy` reads `render.yaml` and fails when either stops
pointing at the service it names, and when the static site declares a `plan` or
`region`, which Render's schema refuses with `additionalProperties: false`. The
second check exists because a `plan: free` on the static site was written here
first, and everything else agreed with it: only Render's published schema
disagreed.

A custom domain later is a DNS record plus one value in `render.yaml` for
`CORS_ALLOWED_ORIGINS` and one for `VITE_API_BASE_URL`. The test above then
holds those two values to the new hostname.

## How these two services exist today

The Render services were created through Render's API, because a Blueprint's
GitHub app authorisation is a dashboard click. Both are linked to the
`feature/staging-deploy` branch with `autoDeployTrigger: checksPass`, so every
commit that passes CI on that branch redeploys. Two steps remain when the branch
merges, and they are the only manual steps in this document:

1. Point both services at `main` (Settings, Branch, or `PATCH /v1/services/{id}`
   with `{"branch": "main"}`).
2. Nothing else. `autoDeployTrigger` is already `checksPass`.

The routes, headers and environment variables that `render.yaml` declares were
applied to the created services; the file and the live services agree, which
`backend/internal/deploy` and `scripts/smoke/deployment-smoke.sh` check from
different sides.

## Configuration

`render.yaml` is the whole deployment. No secret is written in it: anything marked
`sync: false` is prompted for once, in the dashboard, and lives only in Render.

| Variable | Service | Value |
| --- | --- | --- |
| `DATABASE_URL` | API | Neon direct endpoint, `sslmode=require`. Prompted, never committed |
| `RUN_MIGRATIONS` | API | not set. The start script migrates when it is unset; `off` is the only opt out |
| `CORS_ALLOWED_ORIGINS` | API | the dashboard origin, exactly |
| `EVM_RPC_URL` | API | optional Sepolia endpoint; indexing is off when empty |
| `LOG_LEVEL` | API | `info` |
| `VITE_API_BASE_URL` | dashboard | `https://web3-wallet-api.onrender.com/api/v1` |
| `PORT` | API | injected by Render, do not set |

Use Neon's **direct** endpoint, the host without a `-pooler` suffix. The API uses
cached prepared statements and a transaction-pooling endpoint cannot serve those.

`VITE_API_BASE_URL` is compiled into the browser bundle, so it is public by
definition. It must match the origin in `CORS_ALLOWED_ORIGINS`, or the browser
will block every call. Both are validated at their own boundary: the frontend
refuses to build with a malformed value, and the API refuses to start with one.

Local development needs neither. `VITE_API_BASE_URL` unset means the bundle calls
`/api/v1`, which the Vite dev server proxies to `http://localhost:8080`.

`VITE_API_BASE_URL` is refused by the build if it carries a username or password.
A URL like `https://user:password@host/api/v1` parses fine, which is the point:
every character of this value is compiled into the bundle, so accepting it would
publish the credential with a green build. The error names the value with the
credential replaced, so a CI log does not repeat it.

## First deploy

1. Create the Neon project (`aws-ap-southeast-1` to sit beside the Singapore
   API), a role and a database, then copy the direct connection string with
   `sslmode=require` appended. The free plan's compute autoscaling ceiling is
   0.25 to 2 CU; raise it only when there is a paid plan to pay for it.
2. In Render, create a Blueprint from this repository. It reads `render.yaml` and
   asks for the `sync: false` values.
3. Paste the Neon string as `DATABASE_URL`, and a Sepolia RPC URL as `EVM_RPC_URL`.
4. Apply. The API container runs migrations, then starts. Render promotes the
   deploy when `/health/ready` answers 200, which means the database was
   reachable at that moment.
5. Deploy the dashboard. The build fails rather than shipping a bundle pointed at
   a malformed API base.
6. Run the smoke walk against the two live URLs (below).

## Deploying a change

Push to the linked branch, which is `main` once the first deploy is merged and
`feature/staging-deploy` until then. Render redeploys only after CI passes on that
commit (`autoDeployTrigger: checksPass`). There is no manual step: the branch is
staging, and a merge is the deploy.

## Rollback

Application: open the API service in Render, Deploys, pick the last deploy that
was live, and choose **Rollback**. The dashboard is a static site and rolls back
the same way. Rollback redeploys that image; it does not touch the database.

Schema: migrations are forward-only in practice, because a rollback that reverses
a migration can destroy data that the previous release never wrote. The policy is:

- Additive migrations (`ADD COLUMN`, new tables, new indexes) are the default.
  They are safe to leave in place when rolling the code back, so a rollback is
  code only.
- A destructive migration (`DROP`, narrowing a type, a `NOT NULL` on existing
  rows) must ship in its own deploy, after the release that stops using the old
  shape has been live and observed. Never in the same deploy as the code change.
- If a bad migration is already applied, fix it forward with a new migration.
  `migrate down` is for local work only. Running it against staging is a manual,
  deliberate act with a fresh Neon restore point as the safety net, not a
  rollback step.

Neon keeps a 6 hour restore window on the free plan, which covers a mistaken
migration in the same afternoon. It does not cover last week.

## Health and readiness

- `/health/live` answers while the process is up. The container health check uses
  it, so a database blip does not get the container killed and restarted in a loop.
- `/health/ready` answers 200 only when the database accepts a query. Render uses
  it to decide whether a deploy is live.
- Both are unauthenticated and outside the CORS allowlist requirement: they carry
  no CORS headers and no credentials, so a probe from any origin works.

## The smoke walk

`scripts/smoke/deployment-smoke.sh <frontend-url> <api-url>` walks a deployed
environment:

```sh
scripts/smoke/deployment-smoke.sh \
  https://web3-wallet-dashboard.onrender.com \
  https://web3-wallet-api.onrender.com
```

It checks the dashboard is served (including a deep link, which proves the SPA
rewrite works), liveness and readiness, that the CORS allowlist admits the
dashboard origin and refuses another one, and then registers a throwaway account,
logs in, reads the profile, the chain catalog, the wallet list, creates a wallet
and a tracked contract, and reads a paginated events page. It prints a pass and
fail line per step and exits non-zero on any failure.

It never sends a transaction, never needs a funded key and never touches the
Sepolia multisig. It also cannot be run twice from the same address within the
rate-limit window: the auth endpoints are rate limited, so a second run in quick
succession answers 429. Wait for the window or restart the instance.

The same script runs against a local stack if the URLs are loopback:

```sh
go run ./cmd/api                                   # in backend/, DATABASE_URL set
cd frontend && npx vite build && npx vite preview  # serves the built bundle
scripts/smoke/deployment-smoke.sh http://localhost:4173 http://127.0.0.1:8080
```

with `CORS_ALLOWED_ORIGINS=http://localhost:4173` on the API. This is the
rehearsal the local run in the pull request used.

## Secrets

Nothing secret belongs in this repository, in the frontend bundle, or in a log
line. `DATABASE_URL` and `EVM_RPC_URL` are Render environment variables marked
`sync: false`, so they are entered in the dashboard and are not readable from the
repository. The API logs a CORS origin count, never the origins, and never logs a
connection string, a session token or an authorization header.

## Network exposure of the database

The database is on the public internet. Neon gives it a TLS endpoint with a
password, and that is the whole perimeter: port 5432 answers any client that has
the credential.

A private link would need Render's private networking, which does not reach
Neon. An IP allow list is available on the Neon side and is the right next step,
but Render's free tier has no static egress: outbound addresses are shared per
region and change over time, and Render's dedicated IPs are a Pro feature at
$100 a month per set. An allow list built on the shared ranges would work until
Render rotates them and then take the API down, which is worse than the exposure
it removes.

So the exposure is accepted and named rather than papered over:

- TLS on every connection (`sslmode=require`), so the credential is not readable
  in transit.
- One role, `wallet`, owning one database, with a generated 16 character
  password. No other role holds a password.
- Nothing listens on 5432 except PostgreSQL, and there is no database content
  outside the tables the migrations create.
- When a paid plan exists, the allow list is one API call:
  `PATCH /api/v2/projects/{project_id}` with the egress ranges, plus Neon's
  protected-branch setting so only `main` accepts writes.

## Known limitations

- The API is single instance and sleeps. It is not a high-availability deployment.
- The free Neon database is 1 GB and scales to zero, so the first query after an
  idle period pays a wake-up.
- No custom domain, no CDN in front of the API, no autoscaling beyond Neon's
  per-project compute.
- No alerting. A failed deploy is visible in Render and in the smoke walk.
- The database endpoint is reachable from the internet. See the section above;
  the mitigation needs a paid egress plan.
- Staging data is disposable. It is not backed up, and the smoke walk leaves a
  test account, a wallet and a contract behind on every run.
