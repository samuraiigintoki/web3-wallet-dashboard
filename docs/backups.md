# Backups and restores

The staging database is a free Neon Postgres. Neon's free plan keeps a short
point-in-time history and no export, and nothing in this repository took a copy
of it, so a dropped table or a deleted project had no recovery path. This
document describes the copy that now exists, how it is taken, how it is proven,
and how it is used.

Everything here is zero cost: it runs on GitHub Actions' included minutes and
stores artifacts in the repository's own artifact storage.

## What is backed up

The whole database, in `pg_dump`'s custom format: every table, index, constraint
and the row data. Not the Neon project, not its roles and passwords, not the
Render service or its environment variables.

| Piece | Where it lives | Is it in the backup |
| --- | --- | --- |
| Tables, indexes, constraints, rows | Neon | yes |
| Database role passwords | Neon | no, they are rotated by procedure |
| API configuration and secrets | Render and GitHub secrets | no, `render.yaml` is in Git |
| Sepolia contract state | the chain | no, and nothing here may touch it |

A backup is not a substitute for the deployed configuration. If the Neon project
is lost, the database comes back from an artifact and the connection string in
Render is replaced, which is the same procedure a password rotation follows in
`docs/deployment.md`.

## How the nightly backup runs

`.github/workflows/backup.yml` has three jobs:

- **self-test** runs on every pull request that touches the scripts or the
  workflow. It builds the real schema with the real migrations in a throwaway
  Postgres 17, adds 25 rows to a table of its own, takes a backup, restores it
  into an empty database, and requires the row counts to match. It then checks
  that the guards refuse the three things they are meant to refuse. No secret is
  involved, so it runs on a fork too.
- **backup** runs at 20:47 UTC (02:17 IST) and on demand. It dumps staging,
  encrypts the dump, and uploads it as a workflow artifact with 30 day
  retention.
- **drill** runs after it, downloads the artifact that same run produced,
  restores it into an empty Postgres 17 in the runner, and compares the row
  counts against the manifest. A nightly run therefore produces the backup and
  the evidence that this backup restores.

Both scheduled jobs need two repository secrets:

| Secret | What it holds |
| --- | --- |
| `STAGING_DATABASE_URL` | the Neon connection string, the same value as `DATABASE_URL` on the API |
| `BACKUP_PASSPHRASE` | the passphrase the artifacts are encrypted with |

If either is missing the run fails rather than skipping, because a nightly job
that quietly does nothing is not a backup policy.

The passphrase is not in the repository and not in the workflow. **A copy must
exist somewhere other than GitHub.** If it is lost, every artifact becomes
unreadable, which is the property that makes the encryption worth having. Keep
it in a password manager, and rotate it by setting the new value and taking a
fresh backup; artifacts stay readable with the passphrase that was current when
they were taken.

## Where the artifact goes and what is in it

Each run uploads three files, named from one UTC timestamp:

```
wallet-20261025T210958Z.dump.enc          the encrypted dump
wallet-20261025T210958Z.dump.enc.sha256   sha256 of the encrypted file
wallet-20261025T210958Z.json              the manifest
```

The manifest records when it was taken, which database it came from (host only,
never the password or the database name), the `pg_dump` version, the sizes and
sha256 of both the plaintext dump and the encrypted artifact, the cipher, and
the row count of every table. It is what a restore is compared against, and it
holds no credential.

Encryption is `openssl enc -aes-256-cbc` with `-pbkdf2 -iter 600000` and a
random salt, with the passphrase supplied through the environment, never
through an argument, so it does not appear in a process list. This uses
`openssl` from the base image rather than a new dependency.

## Restoring

The scripts are in `scripts/backup/`. Both print only redacted connection
strings, and neither writes a plaintext dump outside a private temporary
directory that is removed on exit.

**The nightly drill is the same command.** To run it by hand against a local
Postgres:

```bash
psql postgres://wallet:wallet@localhost:5432/postgres -c 'CREATE DATABASE restore_target'

DATABASE_URL=postgres://wallet:wallet@localhost:5432/restore_target?sslmode=disable \
BACKUP_PASSPHRASE=... \
  scripts/backup/restore.sh wallet-20261025T210958Z.dump.enc
```

The script decrypts the artifact, checks the plaintext against the manifest's
sha256, runs `pg_restore --clean --if-exists --no-owner --no-privileges
--exit-on-error`, and then compares every table's row count with the manifest.
A mismatch is a failed restore, printed as a diff, not a warning.

Three guards exist so that pointing this at the wrong database is a decision
rather than a typo:

- a target that already holds tables is refused unless `RESTORE_FORCE=1`,
  because `pg_restore --clean` drops what it finds;
- a target that is not this machine is refused unless
  `RESTORE_TARGET_CONFIRMED=1`;
- the connection string is read from the environment, not the command line, so
  it does not land in shell history.

### Recovering staging

1. Provision the replacement database and put its connection string in
   `DATABASE_URL` on the Render service, per `docs/deployment.md`.
2. Download the newest artifact from the successful `Backup` runs in the
   Actions tab. Check it came from a run whose `drill` job passed.
3. Restore into the new database, with both guards set:

   ```bash
   DATABASE_URL="$NEW_DATABASE_URL" \
   BACKUP_PASSPHRASE=... \
   RESTORE_TARGET_CONFIRMED=1 \
   RESTORE_FORCE=1 \
     scripts/backup/restore.sh wallet-...Z.dump.enc
   ```

   The migration table comes back with the data, so the API's start-up
   `migrate up` finds the schema at the version the backup was taken at and
   applies only what is newer.
4. Deploy the API and run `scripts/smoke/deployment-smoke.sh` against the pair.
5. Note the artifact name and the time in the drill log below.

## Drill log

A backup is only evidence once it has been restored. Each row is a restore that
actually ran, with what was compared.

| Date | Where | Artifact | Source | Tables | Rows compared | Result |
| --- | --- | --- | --- | --- | --- | --- |
| 2026-10-25 | local Postgres 17, `restoredb` | `wallet-20261025T210851Z.dump.enc` (118 KB) | local `wallet` | 12 | 12 tables matched, including `users` 5, `contracts` 7, `schema_migrations` 8 | pass |

The same session checked the failure paths, because a guard nobody has seen
fire is a guard nobody knows works:

| Case | Expected | Observed |
| --- | --- | --- |
| wrong passphrase | exit 1, nothing restored | exit 1, `the passphrase is wrong or the file is damaged` |
| target already populated, no `RESTORE_FORCE` | exit 2 | exit 2, names the 12 tables it will not drop |
| target not on this machine, no `RESTORE_TARGET_CONFIRMED` | exit 2 | exit 2, names the host |
| manifest edited so `users` says 99 | exit 1 with a diff | exit 1, diff `users 99` against `users 5` |
| `-Fc` dump of 121 KB | restores in one pass | 0.42 s, 12/12 tables |

### Recorded runs

| Date | Workflow run | Job | Result |
| --- | --- | --- | --- |
| 2026-10-25 | first `Backup` run on this branch | `self-test` | recorded in the pull request once the run finishes |

## What this does not do

- It does not back up continuously. Up to 24 hours of writes are lost in the
  worst case, which for a demonstration environment with no real users is
  accepted and stated here rather than implied.
- It does not keep the artifacts forever. GitHub retains them 30 days, so the
  window of recoverable history is 30 days.
- It does not protect against a passphrase that is lost, or against the
  repository's own secrets being lost with it.
- It does not test a restore to a *different* host on a schedule. The drill
  restores into a Postgres 17 service container in the runner, which proves the
  artifact and the scripts, not the staging credentials.
