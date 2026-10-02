# Step 1 manual verification

All **12 requested checks passed** on **2026-10-02 (Asia/Calcutta)** against source revision `c6824ff`. The database scenarios used real MySQL statements and assertions; the ERD check was a document review against the live schema.

Environment: Windows, Node **24.21.0**, MySQL **8.4.8**, a newly initialized loopback instance on port **51761**. The fresh application schema was `livora_test_step1_manual`; a second fresh schema, `livora_test_step1_preservation`, was used solely to verify refusal of unmanaged populated schemas. Both used a dedicated schema-scoped test login. No pre-existing database was connected to or modified. The existing XAMPP server and workspace `.env` were preserved.

## Requested checklist

| ID  | Check                                                                | Actual result                                                                                                                                                                                                                                                                                                                                                                | Status |
| --- | -------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| P1  | Apply migrations to a fresh empty local database                     | Migrations **001–005** applied successfully: **27 domain tables**, migration metadata and **17 triggers**. Two concurrent migrators applied a total of five migrations. Status then reported **5 applied, 0 pending**.                                                                                                                                                       | PASS   |
| P2  | Person, User, Membership, Flat and Occupancy are separate in the ERD | Reviewed [ERD](../database/ERD.md) against the live tables `persons`, `users`, `society_memberships`, `flats` and `flat_occupancies`. Person has an optional login; User has society memberships; occupancies reference the flat and tenant resident profile.                                                                                                                | PASS   |
| P3  | Create a person without a user account                               | A synthetic Person and society profile were inserted. A left join to `users` returned **zero login accounts** for that Person.                                                                                                                                                                                                                                               | PASS   |
| P4  | One flat has an owner, a tenant and historical tenancy               | `TEST_A` flat `101` retained three occupancy rows: open OWNER from **2020-01-01**, closed TENANT from **2024-01-01 to 2025-12-31**, and open TENANT from **2026-01-01**. Both current relationships and the closed interval remained stored.                                                                                                                                 | PASS   |
| P5  | One user belongs to two societies with different roles               | The same global User had separate memberships: `TEST_A` / `COMMITTEE_ADMIN` and `TEST_B` / `RESIDENT`. Duplicate global identity and membership attempts were also rejected.                                                                                                                                                                                                 | PASS   |
| P6  | Financial columns use DECIMAL(12,2)                                  | Inspected all **seven monetary columns** in `information_schema.COLUMNS`; each was `decimal(12,2)`. A payment of **100.25** was returned intact as a string by mysql2. Quantity and area are separate non-currency fields.                                                                                                                                                   | PASS   |
| P7  | Foreign keys, indexes and tenant-scoped unique constraints exist     | The live schema contained **64 foreign keys**, **54 unique constraints** and **34 CHECK constraints**. Every tenant table had a non-null society key, society FK and unique `(society_id,id)` index. Every FK to a tenant resource included the society key. The flat-number unique index covered `(society_id,building_id,flat_number)`.                                    | PASS   |
| N1  | Duplicate flat number within the same building/society fails         | A second flat `101` in `TEST_A`'s same building was rejected with **ER_DUP_ENTRY (1062)**. Flat `101` in `TEST_B`'s building was allowed.                                                                                                                                                                                                                                    | PASS   |
| N2  | Occupancy end before start fails                                     | An occupancy starting **2026-02-01** and ending **2026-01-01** was rejected by an enforced CHECK constraint, **3819**.                                                                                                                                                                                                                                                       | PASS   |
| N3  | Nonexistent society/person/flat references fail                      | Separate inserts referencing missing society, Person and flat identifiers each failed with **ER_NO_REFERENCED_ROW_2 (1452)**. Cross-society building, profile, role and payment links were also rejected.                                                                                                                                                                    | PASS   |
| N4  | Migrations do not drop existing tables or data                       | Reapplying migrations returned **0 applied**; all rows across **28 tables**, column definitions, constraints and triggers matched the before snapshot. An independent populated schema with a sentinel table and row was rejected before migration metadata creation; its original contents and schema remained identical. Offline validation also rejected destructive SQL. | PASS   |
| N5  | Parent deletion cannot cascade-delete completed financial records    | Deletion attempts for a society, flat, Person and collector/recorder membership each failed with **ER_ROW_IS_REFERENCED_2 (1451)**. After each failure, the entire schema/data snapshot was unchanged. All FK delete/update rules were RESTRICT or NO ACTION.                                                                                                                | PASS   |

## Financial preservation evidence

The blocked parent deletions preserved the following records across both synthetic societies. Three bills included two issued bills and one draft bill; the issued bills and their items also rejected direct edits/deletion in the integration suite.

| Table                 | Rows preserved |
| --------------------- | -------------- |
| `bills`               | 3              |
| `bill_items`          | 2              |
| `bill_adjustments`    | 1              |
| `payments`            | 2              |
| `payment_allocations` | 2              |
| `payment_reversals`   | 1              |
| `receipts`            | 2              |
| `audit_logs`          | 2              |

Before/after comparisons covered every row, including financial amounts, references, dates and audit contents; they were not limited to row counts. The preserved schema/data snapshot's SHA-256 was `664b9d59fccb7eeec601a4be20c0044efd1dcb228d253780caa9a676541f0d07`.

## Executed checks and reproduction

- `npm run check`: formatting, lint, strict typecheck, **7 offline tests**, build and validation of **5 additive migrations** passed.
- `npm run test:db`: **17 tests passed**, **0 failures**, **0 skips** on the empty schema. See [integration scenarios](../../tests/database.integration.test.ts) and [tenant schema checks](../../tests/schema-contract.ts).
- `npm run db:status`: **5 applied, 0 pending**.
- `npm run db:migrate`: **0 applied** on reapplication; additional before/after comparisons confirmed preservation of populated data and schema objects.
- Additional isolated assertions verified unmanaged-schema refusal and the four parent-deletion preservation checks above.
- `npm audit --audit-level=high`: **0 reported vulnerabilities**.
- Gitleaks **8.30.1**: no leaks in committed history or a snapshot of all nonignored source files, including this report.
- Actionlint **1.7.12**: workflow syntax passed. Final formatting and Git whitespace checks passed; the frontend repository remained clean.

To reproduce, follow [database setup and migration safety](../database/MIGRATION_PLAN.md) and [README](../../README.md). Configure a **new empty** loopback MySQL 8.4 schema whose name starts with `livora_test_`, use `NODE_ENV=test`, and run `npm run test:db`. The suite leaves its synthetic fixtures for inspection and deliberately refuses populated schemas; create a different empty schema for another run. Credentials must remain in ignored local configuration. The test-only trigger policy must be configured by the administrator of the isolated instance as documented; do not change a shared server's policy.

The extra unmanaged-schema check created a sentinel table and row only in the second newly provisioned schema, attempted migration, and compared the tables, rows and catalog before/after refusal. No DROP/TRUNCATE, destructive rollback or successful parent deletion was performed. The temporary verification helpers, random credentials, detailed evidence and database files remain Git-ignored under `.local-db/`. The dedicated MySQL instance was shut down after verification, retaining its test data for inspection.

No migration or business implementation needed changing. Step 1 remains database architecture and migration tooling only; frontend work and later roadmap steps were not started.
