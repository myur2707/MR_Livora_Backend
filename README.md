# MR Livora backend

Step 10 adds [committee notices and complaint workflows](docs/community/STEP_10_COMMUNITY.md), with [executed verification results](docs/testing/STEP_10_VERIFICATION.md). Apply additive migration 014 and provision explicit community permissions/runtime grants; the managed local runner handles this safely.

A smarter way to live together.

Step 9 adds the [resident portal API and approved privacy policy](docs/resident/STEP_9_RESIDENT_PORTAL.md), [threat model](docs/security/RESIDENT_PORTAL.md), [verification](docs/testing/STEP_9_VERIFICATION.md) and [real-stack manual checklist results](docs/testing/STEP_9_MANUAL_VERIFICATION.md). No migration is added; the guarded local stop/start runner rebuilds both apps and updates narrow runtime grants while preserving existing accounts and records.

Steps 1, 3–9 implement the shared-schema database, safe migrations, authentication/authorization, society onboarding, property/resident management, verified resident access, maintenance configuration/billing, payment recording and the resident portal. `../MR_Livora_Frontend` is the separate Angular PWA repository. Follow [AGENTS.md](AGENTS.md) before further work.

Step 7's [billing policies and API](docs/billing/STEP_7_BILLING.md), [additive schema](docs/database/BILLING_SCHEMA.md) and [threat model](docs/security/BILLING.md) cover exact money, full monthly charges without proration, scoped immutable configuration versions, reviewed generation, discounts, idempotency and outstanding reports. Apply migration 012, run `npm run db:billing-permissions` with the migrator and provision its narrow runtime grants before starting the new API. Managed `local:stop` / `local:start` upgrades existing local data without resetting accounts. Step 8 adds payment recording, allocation, immutable receipts and append-only returns/corrections; follow docs/billing/STEP_8_PAYMENTS.md, docs/database/PAYMENT_SCHEMA.md and docs/security/PAYMENTS.md.

Authentication setup, API contracts, runtime DB grants, SMTP and the optional isolated development seed are documented in [authentication](docs/security/AUTHENTICATION.md), with a [threat model](docs/security/THREAT_MODEL.md) and [additive auth schema](docs/database/AUTH_SCHEMA.md). Apply migrations 006–007 with the migrator before starting the API; use separate APP_DB_USER/APP_DB_PASSWORD runtime credentials. Run `npm run dev` locally or `npm run build` then `npm start` for compiled execution. Both API and Angular must use the same browser origin.

Step 4 API, criteria, privacy, concurrency and rollout are documented in [society onboarding](docs/security/SOCIETY_ONBOARDING.md). Apply additive migration 008 and its narrow runtime grants before running the updated API. Existing society data is preserved.

Step 5 contracts, import/privacy controls and archive rules are in [property management](docs/security/PROPERTY_MANAGEMENT.md), with [additive migration 009](docs/database/PROPERTY_SCHEMA.md). Apply 009 and its column-specific runtime grants before starting the updated API.

## Prerequisites and local setup

Step 6's [resident access contract and threat model](docs/security/RESIDENT_ACCESS.md) and [schema](docs/database/RESIDENT_ACCESS_SCHEMA.md) cover email verification, committee invitations and pending membership requests. Apply additive migrations 010–011 and their column-specific runtime grants before starting the updated API. Existing accounts and occupancy history are reused without identity merges. The [Step 6 verification report](docs/testing/STEP_6_VERIFICATION.md) records checks and retained local demonstrations.

For the configured Windows workspace, see [local manual testing](docs/testing/LOCAL_TESTING.md). Run `npm run local:start` to start both projects, the isolated database and reset-email inbox; `local:setup` prepares a new workspace once, and `local:stop` retains its data. Generated test credentials are in ignored `.local-db/manual/TEST_ACCOUNTS.md`.

- Node **24 LTS** and its bundled npm. `.node-version` selects the major; dependency versions are exact and `package-lock.json` is included for reproducible installs. The inspected machine had Node 20.18.1; portable Node 24 was used for checks because Node 20 is EOL. No existing project packages were upgraded.
- **MySQL 8.4 LTS** with InnoDB and `STRICT_TRANS_TABLES`. This supported MySQL 8 line has enforced CHECK constraints. MariaDB is not a drop-in validation substitute. Integration validation targets 8.4.8.

Run from this repository root:

```sh
npm ci
npm run check
```

An administrator must provision an **empty** isolated local `livora_dev_local` schema using utf8mb4/utf8mb4_0900_as_ci, and a dedicated schema-scoped migration user. See [migration plan](docs/database/MIGRATION_PLAN.md) for privileges and production safety. Copy `.env.example` to `.env`, replace the password locally and set connection details. Never commit it. Remote connections require `DB_TLS_CA_FILE` with certificate verification.

```sh
npm run db:validate
npm run db:status
npm run db:migrate
npm run db:status
```

Validation does not connect to MySQL; status is read-only. Migration uses a per-schema advisory lock and rejects checksum drift, partial history and unmanaged populated schemas. Use `node dist/database/cli.js migrate` after `npm run build` if running compiled tools; SQL files remain in `database/migrations` and the working directory must be this repository root.

## Checks

| Command                                   | Purpose                                                                          |
| ----------------------------------------- | -------------------------------------------------------------------------------- |
| `npm run check`                           | Format, lint, strict TypeScript, offline tests, build, migration validation      |
| `npm run test:db`                         | Real-MySQL migration, integrity, identity, tenant boundary and append-only tests |
| `npm run format` / `npm run check-format` | Consistent formatting / verification                                             |
| `npm audit`                               | Dependency vulnerability report; do not use forced automatic upgrades            |

To run integration tests, separately provision a **new, empty loopback** schema named `livora_test_<unique_suffix>` and its dedicated user. Configure `NODE_ENV=test` and that DB name in local environment variables or `.env`. The test refuses a nonempty schema, applies migrations and writes synthetic fixtures. It leaves those fixtures for inspection; no drops or cleanup of existing DB data occur. Each run requires a new empty test schema. Do not use a shared or production server.

```sh
npm run test:db
```

Integration tests additionally require explicit APP_DB_USER, APP_DB_PASSWORD and DB_TEST_ADMIN_PASSWORD for the isolated service. The guarded test provisioner grants restricted runtime privileges after migration and verifies denied DDL, completed-finance rewrites/deletes and role/audit writes. CI uses disposable service credentials. Administrator settings are test-only and never consumed by the server.

CI uses `npm audit`, weekly Dependabot updates and a checksum-verified, version-pinned Gitleaks binary to scan repository history locally. No paid scanning account or source-uploading service is required. Local secret scanning should include changed/untracked nonignored source files as well as Git history.

## Architecture and database docs

- [ERD and design choices](docs/database/ERD.md)
- [Data dictionary](docs/database/DATA_DICTIONARY.md)
- [Constraints, indexes and concurrency](docs/database/CONSTRAINTS_AND_INDEXES.md)
- [Tenant isolation and threat model](docs/database/TENANT_ISOLATION.md)
- [Resident onboarding](docs/database/RESIDENT_ONBOARDING.md)
- [Migration, recovery, archive and seed policy](docs/database/MIGRATION_PLAN.md)
- [Engineering and security standards](docs/ENGINEERING_STANDARDS.md)
- [Validation log](docs/testing/MANUAL_TEST_LOG.md)

Stored instants use UTC `DATETIME(6)` with UTC DB sessions. Display in society timezone (`Asia/Kolkata` by default); `DATE` fields are society-local calendar dates. Financial DECIMAL and BIGINT values remain strings at JavaScript boundaries. Completed financial and audit records are append-only, with explicit adjustment/reversal records.

Authentication and management use thin Express handlers, services and parameterized SQL under `/api/v1`. Step 8 adds financial recording without a payment gateway; general support access remains a later step. The schema's tenant constraints supplement server session/membership/permission checks.

Step 8: [payment policies/API/rollout](docs/billing/STEP_8_PAYMENTS.md), [additive payment schema 013](docs/database/PAYMENT_SCHEMA.md), [security](docs/security/PAYMENTS.md) and [verification](docs/testing/STEP_8_VERIFICATION.md). Stop/start the owned local stack after checks to safely upgrade without resetting existing accounts.

The [Step 7 and Step 8 checklist verification](docs/testing/STEP_7_8_MANUAL_VERIFICATION.md) records billing/payment checks, regression fixes and the remaining physical print/reconciliation checks.

Step 11: [dashboard/report API, date and CSV policies](docs/reports/STEP_11_REPORTS.md), [threat model](docs/security/REPORTS.md) and [verification](docs/testing/STEP_11_VERIFICATION.md). No new schema migration; provision additive report permissions after Step 10.
