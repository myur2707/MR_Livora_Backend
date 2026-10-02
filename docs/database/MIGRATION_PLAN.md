# Safe migration and retention plan

## Ordered baseline

| Version | Content                                                                                                 |
| ------- | ------------------------------------------------------------------------------------------------------- |
| 001     | Societies, Person/User identity, tenant profiles/memberships, roles/permissions/grants                  |
| 002     | Buildings/flats, occupancy history, invitations and pending registration                                |
| 003     | Versioned charges, billing periods/bills/items, payments/allocations/receipts and corrections/reversals |
| 004     | Notices, private complaints and tenant audit logs                                                       |
| 005     | 17 append-only / issued-bill guards                                                                     |

The initial five migrations contain 27 domain tables plus `_schema_migrations`. Step 3 migration 006 adds five global identity/security tables and two audit triggers, and 007 adds automatic account credential revocation; see [auth schema](AUTH_SCHEMA.md) for dictionary, FKs and safe rollout. There are no drops, cascade deletes or automatic down commands. Migration SQL is committed, not generated at runtime.

## Provisioning and privileges

An administrator creates a fresh empty schema (do not reuse/overwrite a populated database):

```sql
CREATE DATABASE livora_dev CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_as_ci;
```

Create a dedicated local migration login with a unique local password using secure administrator tooling. Grant only on this schema: SELECT, INSERT, UPDATE, CREATE, REFERENCES and TRIGGER. The runner needs SELECT/INSERT/UPDATE on its metadata, CREATE for additive tables, REFERENCES for foreign keys and TRIGGER for guards. No DROP, ALTER, DELETE, GRANT OPTION, FILE or server-admin privilege is needed for this baseline. Deploy migrations separately from the application runtime. MySQL binary-logging policy may require DBA configuration for trigger creation; do not grant broad server privileges just to bypass it.

Runtime credentials must be separate. Grant SELECT/INSERT only on append-only tables (`payments`, `payment_allocations`, `payment_reversals`, `receipts`, `bill_adjustments`, `audit_logs`); mutable tables receive narrowly justified grants for future modules. No access to migration metadata or DDL. Production MySQL is private-network only; remote tool connections require a trusted CA and verified TLS. Runtime connections must also set UTC and strict SQL mode, and preserve DECIMAL/BIGINT strings.

## Runner behavior

1. Offline `db:validate` loads ordered 3-digit files, checks contiguous versions and additive CREATE TABLE/TRIGGER statements, rejects unsafe/drift-hiding SQL and hashes normalized LF content with SHA-256. Explicit `-- statement-breakpoint` boundaries preserve multi-statement trigger bodies. Validation is a repository guard, not a general SQL parser or substitute for executing real MySQL.
2. `db:status` validates history/checksums without mutation. A populated schema without metadata is unmanaged; status may report pending files, but `db:migrate` refuses to baseline it.
3. `db:migrate` validates MySQL 8.4/strict mode, sets UTC and acquires a 10-second bounded per-schema GET_LOCK. It checks metadata **after** acquiring the lock, so simultaneous runners serialize.
4. The first migration requires an empty schema (operational metadata alone may exist). Each file inserts a STARTED marker before executing ordered SQL statements, then records APPLIED/time after success. Success markers and table DDL are autocommitted. Subsequent runs skip checksum-matching APPLIED files.
5. Unknown/reordered/renamed versions, checksum drift and STARTED entries fail closed. SQL errors leave the marker and any already-created objects for inspection. Safe CLI output omits raw driver errors, SQL, paths and stack traces. Inspect MySQL operator logs or reproduce in an isolated environment for diagnosis.

**MySQL DDL implicitly commits**; neither a transaction wrapper nor a down migration can promise rollback of the whole baseline. See [MySQL implicit commits](https://dev.mysql.com/doc/refman/8.4/en/implicit-commit.html). CREATE TABLE atomicity does not make a multi-table migration atomic.

## Partial failure and future changes

Stop dependent deployment and inspect _schema_migrations, SHOW CREATE TABLE/TRIGGER and actual applied statements. Restore the original migration file if its checksum changed. Do not automatically retry, delete metadata or drop partial tables. In an explicitly disposable test environment, an operator can provision a **different new empty schema**; the existing one is left intact.

For real data, back up and prove restore first. A DBA must approve a documented recovery: either manually complete missing statements and verify every object before changing STARTED to APPLIED with the original checksum, or restore a verified backup. No recovery mutation is automated. Initial installation requires a deployment window: the DB is not ready until all guards are installed and the full ledger is APPLIED.

Later changes add new numbered migrations. This runner intentionally allows only additive CREATE TABLE/TRIGGER initially; reviewed ALTER/backfill support must be added/tested before a future step needs it. Prefer expand/backfill/verify/contract with deployment compatibility. Do not edit applied baseline migrations. Removal of baseline tables is destructive and requires separate explicit approval; no automatic down command is provided.

## Development fixtures and validation

`npm run test:db` refuses non-test, non-loopback or nonempty targets. Provision a new `livora_test_<suffix>` schema/user, set NODE_ENV=test and execute. Fixtures use `.invalid` emails, synthetic names/notes and random token digests. They create pending users with no password hashes; no seeded account can log in. Two societies share one User with different roles, and a resident has no login. Completed bills/payments/receipts and a reversal remain for inspection. Tests never drop tables/databases or disable constraints.

No automatic `db:seed` command or known default credentials. To explore manually, use the integration fixtures on a disposable schema; never import them into production. Production permission/role catalogs will be added explicitly with the authorization step, with no predefined admin password.

Local `npm run check` includes offline tests and a tooling build; real-DB tests are a separate required gate. CI provisions a dedicated fresh 8.4.8 service. Its isolated administrator helper enables `log_bin_trust_function_creators` for schema-scoped trigger creation before tests; this does not change production policy. The local disposable server used the same explicit setup. The integration-test login also needs DELETE on test tables to verify restrictive FKs/guards; that is a test-only grant, not a runtime recommendation. Check formatting, lint, strict types, tests/build, DB invariants, idempotent reapplication and migration validation. Never claim hosted CI passed until it ran.

## Archive, deletion and retention

| Data                                      | Rule                                                                                                                             |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Society/profile/building/flat/role/charge | Archive or lifecycle deactivate; preserve referenced identifiers                                                                 |
| User/membership                           | Disable/deactivate; withdraw access without deleting global identity or evidence                                                 |
| Occupancy                                 | Close dates and preserve history; no silent replacement                                                                          |
| Invites/registration                      | Preserve decision history; expire/revoke/cancel, not reuse token. Retention and safe PII minimization require reviewed policy    |
| Bills/items                               | Drafts may be changed under locks; issued rows frozen; append bill adjustments                                                   |
| Payments/allocations/receipts             | Completed inserts only, UPDATE/DELETE blocked; full-payment reversal appended; no partial refund model yet                       |
| Audit                                     | Append-only, minimal safe metadata, system actor nullable; retain linked opaque identifiers. No secrets/raw bodies/PII snapshots |
| Notices/complaints                        | Archive rather than erase published/decided content; audit future state changes                                                  |

Retention durations are deliberately not invented. Before production, the society/operator must approve personal-data retention, financial/audit retention and controlled anonymization with applicable requirements. Profile contact/name fields can be minimized under reviewed policy; completed ledger IDs remain. Ordinary runtime users cannot purge history. If later legal erasure requires a change to an immutable record, it needs a separately reviewed, authorized administrative migration and audit trail.
