# Backend rules

These rules travel with this independent repository. Follow the engineering/security baseline in `docs/ENGINEERING_STANDARDS.md`; it mirrors the workspace rules.

- Step 1 contains database architecture and tooling only. Do not add Express endpoints or business services until requested.
- Runtime target: Node 24 LTS; MySQL 8.4 LTS, InnoDB, utf8mb4, enforced checks and UTC sessions. Use mysql2 parameterized raw SQL, no ORM.
- Run `npm run check` and, with an isolated empty MySQL schema, `npm run test:db`. Never point integration tests at shared/production data. `npm run test:db` requires a schema name prefixed `livora_test_` and refuses a nonempty schema.
- Migrations are ordered, checksum-verified, additive SQL with explicit statement boundaries. Never edit an applied migration. Partial DDL failure requires operator inspection; do not automatically retry or delete data.
- Every society-owned relationship uses a composite society/resource foreign key. Global identity is accessed through tenant-specific `society_persons`; tenant code must not list global users/persons.
- Archive and append corrections/reversals; no cascade deletes. Do not add destructive down commands for the baseline.
- Keep DB credentials separate from the application; use TLS for remote databases. Keep DECIMAL and BIGINT values as strings at JavaScript boundaries.
- Run and report formatter, lint, typecheck, tests, build, migrations and git-diff review. Do only the requested roadmap step.
