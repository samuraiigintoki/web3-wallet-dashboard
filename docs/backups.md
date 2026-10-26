# PostgreSQL backups and restore

This procedure creates an encrypted, custom-format PostgreSQL 17 dump and verifies that it can be restored into a new, empty PostgreSQL 17 database. The nightly job uploads ciphertext only. The private `age` identity is never needed by GitHub Actions.

## Required GitHub configuration

Add these repository or organization Actions secrets before the first scheduled or manually dispatched backup:

| Secret | Value |
| --- | --- |
| `STAGING_DATABASE_URL` | PostgreSQL connection URI for the database to export. Use a dedicated account with the minimum privileges required to dump all application schemas and data. |
| `BACKUP_AGE_RECIPIENT` | The public `age1...` recipient corresponding to the recovery identity. This is a public encryption key, not the private identity. |

Both values must be set for the `encrypted-backup` job. The workflow validates the recipient before exporting. It requires PostgreSQL 17 client tools and accepts a single-host `postgres://` or `postgresql://` URI. The scripts require Bash and Python 3. They write the URI to a mode-600 temporary libpq service file and remove it on exit; they do not pass the credential-bearing URI to PostgreSQL process arguments or print it. Newlines and trailing whitespace in URI values are not supported by libpq service files.

### Create and protect the recovery identity

On a trusted machine, install `age`, then create the recovery identity in a protected location:

```sh
umask 077
mkdir -p "$HOME/.config/age"
age-keygen -o "$HOME/.config/age/staging-db-backup.txt"
age-keygen -y "$HOME/.config/age/staging-db-backup.txt"
```

Copy only the displayed public `age1...` recipient into the `BACKUP_AGE_RECIPIENT` Actions secret. Keep the identity file private and outside GitHub, the repository, the runner, and all artifacts. Maintain an offline, access-controlled recovery copy. Do not paste the identity into logs, issues, pull requests, or documentation.

For key rotation, first set the new public recipient, then run a manual backup and verify that its artifact decrypts with the new identity. Keep the old identity available offline until every artifact encrypted to the old recipient has expired. Never delete the only recovery identity for a retained backup.

## Schedule, artifact access, and retention

`.github/workflows/backup.yml` runs on the default branch every day at 20:47 UTC (02:17 the following day in India). GitHub may delay scheduled runs during periods of high load. Use **Actions → PostgreSQL encrypted backup → Run workflow** on `main` to start a backup manually. A manual dispatch on another branch runs the restore self-test only; it will not export the configured database.

A successful backup creates an artifact named `postgres-backup-<run-id>` containing one file, `postgres-backup-<run-id>.dump.age`. The artifact is retained for 7 days. This repository is public, so treat workflow artifacts as accessible to repository readers; download permissions follow repository read access ([GitHub Actions artifact access](https://docs.github.com/en/actions/managing-workflow-runs/downloading-workflow-artifacts)). Encryption protects the dump contents, not artifact names, timestamps, run metadata, or the fact that a backup exists.

The workflow encrypts the custom-format dump with `age` before upload. It deletes the plaintext file before staging the artifact, and a cleanup step removes the runner's encrypted working copy after upload. No plaintext dump is uploaded or retained as an artifact. Backups are finite-retention recovery copies, not a point-in-time recovery service. The scheduled copy may be about a day old, and a missed or delayed run increases that window.

## Retrieve, decrypt, and restore

1. Open the latest successful backup run in the repository's **Actions** tab and download its `postgres-backup-<run-id>` artifact. The GitHub CLI can also download it:

   ```sh
   gh run download <run-id> -n postgres-backup-<run-id> -D ./db-backup
   ```

2. On a trusted machine with `age` and PostgreSQL 17 client tools installed, decrypt to a protected local file. Use the private identity file, never a passphrase or the public recipient:

   ```sh
   umask 077
   age --decrypt \
     --identity "$HOME/.config/age/staging-db-backup.txt" \
     --output ./restore.dump \
     ./db-backup/postgres-backup-<run-id>.dump.age
   ```

3. Create a new, disposable, empty database on the intended PostgreSQL 17 server. Do not point the restore at a production database or a database that contains data you need. The target account must be able to create the application's schema and objects. Provide its PostgreSQL connection URI through a protected shell environment, not a command argument, shell history, or committed file. For an interactive Bash session:

   ```sh
   read -rsp 'Empty target PostgreSQL URI: ' TARGET_DATABASE_URL
   printf '\n'
   export TARGET_DATABASE_URL
   ```

4. Run the restore and clear the shell variable when finished:

   ```sh
   scripts/db-restore.sh ./restore.dump
   unset TARGET_DATABASE_URL
   ```

   `db-restore.sh` requires `TARGET_DATABASE_URL` explicitly. It checks the target before writing and refuses any target with user objects or large objects. It does not use `pg_restore --clean` or `--create`; it restores in one transaction and rolls back a failed restore. PostgreSQL 17 `pg_restore` and `psql` are required. Keep the decrypted dump in protected storage and securely remove it when the recovery task is complete.

5. Verify the restored application schema and representative records before directing any application traffic to the database. Follow the application's normal recovery and credential-rotation procedure before using a restored database.

## Automated restore drill

For pull requests, pushes to `main`, and manual dispatches, the `restore-drill` job starts a disposable PostgreSQL 17 service, applies the repository's real migrations, inserts a test user and wallet, exports the database, encrypts and decrypts it with an ephemeral test identity, then restores into a separate new database. It verifies all 8 migration records, the 3 seeded chains, the test user and wallet, and the `contract_events` table. The ephemeral private test identity and all dump files are deleted at job exit and are never uploaded.

The same job checks that export without `DATABASE_URL` is rejected; missing and malformed restore targets are rejected; a nonempty target is rejected without changing its wallet row; and invalid `age` recipients and identities fail.

**Recorded hosted drill:** passed on 2026-10-26 UTC at commit [`4f26c9f`](https://github.com/samuraiigintoki/web3-wallet-dashboard/commit/4f26c9f45914fc18e35982c9df63d5875548348b). The [workflow run](https://github.com/samuraiigintoki/web3-wallet-dashboard/actions/runs/40348726609) completed successfully; its `restore-drill` job used PostgreSQL 17 and verified the 8 migrations, 3 seeded chains, test user and wallet, and `contract_events` table. The required failure checks passed in the same job.

## Scope and limitations

This is a single-database dump. It does not include cluster-wide roles, server settings, or other databases. Owner and ACL restoration is disabled, so recreate required roles and grants separately during recovery.

These backups do not make the Neon endpoint private, enable private networking, or satisfy issue #104. They provide encrypted export and a tested restore path only. Keep endpoint exposure and network controls tracked separately, and do not treat a backup as a substitute for private connectivity or a dated, owner-approved exception. Do not merge this work until the owner-approved, dated exception wording for issue #104 is recorded.
