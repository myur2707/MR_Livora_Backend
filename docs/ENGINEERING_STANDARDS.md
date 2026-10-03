# MR Livora engineering rules

Implement only the step the user requests and stop after checks. The roadmap is reference material, not permission to execute later steps. Read project-local AGENTS.md before changes.

The workspace contains two separate Git repositories: `MR_Livora_Backend` (Node API and database) and `MR_Livora_Frontend` (Angular PWA). Preserve these boundaries. The workspace root is not a Git repository. Do not initialize it or move the projects without an explicit request.

## Stack and engineering

- Use a modular monolith: Angular standalone/TypeScript/Tailwind/PWA; supported Node LTS/Express/TypeScript REST under `/api/v1`; MySQL 8/mysql2 with parameterized raw SQL. No ORM.
- Inspect existing packages, configuration, migrations, architecture and checks first. Preserve working conventions; explain major upgrades. Pin package versions and commit lockfiles.
- Strict TypeScript, consistent ESLint and Prettier rules. Fix issues instead of globally disabling rules. Avoid `any`, non-null assertions, `@ts-ignore`, lint/Sonar suppressions; document unavoidable narrow exceptions.
- Small cohesive functions; thin controllers, services for business rules, focused repositories for data access. Inject important dependencies and nondeterministic effects. Prefer composition; avoid hidden globals, duplication, giant files, needless abstractions, magic values, dead/commented code and deep nesting.
- Use named domain states/permission keys, consistent names and client-safe API errors. Comments explain why. Never claim Sonar compliance without running analysis.
- Use environment-specific configuration and placeholder-only `.env.example`. Ignore secrets, credentials, certificates, local env files, dumps and generated outputs. Document setup and configuration changes.
- Configure lockfile installs, lint, typecheck, meaningful tests, production build and migration validation in CI where practical. Free dependency/secret scanning only; no paid services or source-uploading tools without approval.

## Security and domain invariants

- Document assets, actors, trust boundaries, abuse cases and mitigations for material features. Backend authorization is required on every request; frontend guards are UX only.
- Derive active society from authenticated identity plus validated membership. Validate every client identifier, role, collector, flat and resource scope; enforce tenant scope on reads, writes, nested resources and exports. Platform Admin has no implicit access to tenant private/financial data; support access is explicit, scoped and audited, time-limited where practical.
- Validate path/query/body/files/pagination/sorting/enums at the API boundary. Allowlist fields against mass assignment and dynamic SQL identifiers; parameterize all SQL values.
- Separate least-privilege runtime and migration DB users. Do not expose production MySQL publicly or use root credentials in the application.
- Person is distinct from User and may have no account. One global account may have different roles in multiple societies. Link existing accounts without duplicates. Preserve flat occupancy history (owner, tenant, family member, authorized occupant). Admin-created/imported residents need no login; self-registration stays pending until approved.
- Use Argon2id or appropriately configured bcrypt for passwords. Prefer server-managed Secure/HttpOnly/SameSite cookie sessions with CSRF protection; document alternatives. No long-lived secrets in localStorage. Random, hashed, expiring, single-use reset/invitation tokens. Rate-limit abuse-prone endpoints and prevent enumeration.
- Secure headers, restrictive CORS, production HTTPS, safe cookies and request limits. Safe logs with correlation IDs; no passwords, tokens, secrets, full payment credentials or unnecessary personal/financial data. Centralize errors; no stack traces, SQL, paths or internal details in client responses.
- Uploads require authorization, size/type/content checks, random storage names, safe downloads and a malware-scanning strategy. PWA caches only static assets/app shell; never authenticated APIs or private bills/payments/receipts without a reviewed design.
- Financial amounts are DECIMAL(12,2); operations require transactions, idempotency, conflict handling and immutable audit history. Reverse/refund rather than delete completed transactions. Committee physically collects cash; the system records it digitally.
- Tenant-scoped foreign keys, uniqueness, checks and indexes supplement application validation. Test races and cross-tenant boundaries. Audit sensitive/security/financial actions; ordinary users cannot modify/delete audit logs.
- Minimize personal data and document retention/deactivation. No known production seed credentials; development fixtures must be explicitly isolated.
- Platform onboarding is initial setup; committee operates the society. No paid integrations or speculative Redis/Kafka/Elasticsearch/Kubernetes/microservices without explicit approval and business justification.

## Completion gates

- Run relevant formatter, lint, typecheck, domain/security/integration tests, build and migration validation. Tests verify behavior and boundaries; never weaken assertions to pass.
- Review git diff for secrets, debug output, generated junk and unrelated changes. Preserve user changes. Never claim unexecuted checks passed; document blocked checks precisely.
- Never drop/overwrite existing database data or run destructive database commands without explicit approval. Prefer additive migrations; MySQL DDL is not transactionally reversible.
- Report summary, changed files, migrations, executed checks/results, remaining manual checks, risks and next step. Stop; do not start later roadmap steps.
