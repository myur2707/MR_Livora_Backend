# Backend rules

These rules travel with this independent repository. Follow the engineering/security baseline in `docs/ENGINEERING_STANDARDS.md`; it mirrors the workspace rules.

- Steps 1, 3–6 contain database architecture, authentication, initial society onboarding, property/resident management and verified resident access. Preserve applied migrations, auth/tenant boundaries and immutable verification. Follow docs/security/SOCIETY_ONBOARDING.md, docs/security/PROPERTY_MANAGEMENT.md and docs/security/RESIDENT_ACCESS.md. Step 7 adds maintenance configuration and bill generation; follow docs/billing/STEP_7_BILLING.md and docs/security/BILLING.md. Step 8 adds payment recording, allocation, immutable receipts and append-only returns/corrections; follow docs/billing/STEP_8_PAYMENTS.md, docs/database/PAYMENT_SCHEMA.md and docs/security/PAYMENTS.md.
- Runtime target: Node 24 LTS; MySQL 8.4 LTS, InnoDB, utf8mb4, enforced checks and UTC sessions. Use mysql2 parameterized raw SQL, no ORM.
- Run `npm run check` and, with an isolated empty MySQL schema, `npm run test:db`. Never point integration tests at shared/production data. `npm run test:db` requires a schema name prefixed `livora_test_` and refuses a nonempty schema.
- Migrations are ordered, checksum-verified, additive SQL with explicit statement boundaries. Never edit an applied migration. Partial DDL failure requires operator inspection; do not automatically retry or delete data.
- Every society-owned relationship uses a composite society/resource foreign key. Global identity is accessed through tenant-specific `society_persons`; tenant code must not list global users/persons.
- Archive and append corrections/reversals; no cascade deletes. Do not add destructive down commands for the baseline.
- Keep DB credentials separate from the application; use TLS for remote databases. Keep DECIMAL and BIGINT values as strings at JavaScript boundaries.
- Run and report formatter, lint, typecheck, tests, build, migrations and git-diff review. Do only the requested roadmap step.
