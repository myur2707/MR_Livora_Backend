# MR_Livora_Backend

Smart Community Management — Connect. Manage. Live Better.

Steps 1 and 3 implement SocietyEase/MR Livora's shared-schema database, safe migrations and backend authentication/authorization. Business APIs remain unimplemented. `../MR_Livora_Frontend` is the separate Angular PWA repository. Follow [AGENTS.md](AGENTS.md) before further work.

Authentication setup, API contracts, runtime DB grants, SMTP and the optional isolated development seed are documented in [authentication](docs/security/AUTHENTICATION.md), with a [threat model](docs/security/THREAT_MODEL.md) and [additive auth schema](docs/database/AUTH_SCHEMA.md). Apply migrations 006–007 with the migrator before starting the API; use separate APP_DB_USER/APP_DB_PASSWORD runtime credentials. Run `npm run dev` locally or `npm run build` then `npm start` for compiled execution. Both API and Angular must use the same browser origin.

## Prerequisites and local setup

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

Integration tests additionally require explicit APP_DB_USER, APP_DB_PASSWORD and DB_TEST_ADMIN_PASSWORD for the isolated service. The guarded test provisioner grants restricted runtime privileges after migration and verifies denied DDL, finance reads and role/audit writes. CI uses disposable service credentials. Administrator settings are test-only and never consumed by the server.

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

Authentication now uses thin Express handlers, services and parameterized repositories under `/api/v1`. Support access, resident flows and billing calculations remain later steps. The schema's tenant constraints supplement server session/membership/permission checks.
