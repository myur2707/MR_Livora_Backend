# Step 3 authentication and authorization

Step 3 adds authentication only. Existing migration files 001–005 and completed financial/audit records are preserved. No business APIs, onboarding approvals, resident directory, finance screens or support impersonation are implemented.

## Run locally

Use Node 24, MySQL 8.4, `npm ci`, and the existing migration workflow. Configure an isolated empty `livora_dev_<name>` schema, run `npm run db:migrate` with migration credentials, then provision the separate runtime user described below. Application startup never migrates or grants privileges.

Copy placeholder-only `.env.example` to ignored `.env`. Set `APP_DB_USER`/`APP_DB_PASSWORD` separately from `DB_USER`/`DB_PASSWORD`. Generate `AUTH_SECRET` with the documented crypto command; rotating it invalidates CSRF tokens and rate-limit keys. Restart all instances together when rotating, then revoke old sessions through an authorized operator.

Configure an existing SMTP account and verified sender with authenticated TLS (465 implicit TLS or 587 STARTTLS). Certificate validation cannot be disabled. Sender configuration is server-only. No SMTP credentials, reset link or token is logged or returned by the API.

For the optional development account: choose `DEV_AUTH_PASSWORD` of 15–128 characters and run `npm run auth:seed` with `NODE_ENV=development`, a loopback `livora_dev_*` schema, and migration credentials. It creates `developer@example.invalid`, an explicit platform grant and one committee-admin development membership. It refuses production, a shared schema and overwriting an existing account. Never deploy this fixture or use a known default password. Production account activation/platform grants remain reviewed operator actions; login and reset never grant roles or activate pending/disabled accounts.

Run `npm run dev` (port 3000) and Angular `npm run dev` (127.0.0.1:4200). Angular proxies `/api/**`; `APP_ORIGIN=http://127.0.0.1:4200`. There is no permissive CORS. In production serve Angular and `/api/v1` under the same exact HTTPS origin. Set `NODE_ENV=production`, `APP_ORIGIN=https://your-host`, and, only behind a controlled proxy, `TRUSTED_PROXY_IP` to its exact address. The proxy must replace forwarding headers, preserve Origin/Cookie, terminate HTTPS and prevent direct external API access. Other forwarded client IPs are ignored by Express. Startup validates origins/configuration without printing secrets.

## API contract

All responses under `/api/v1` send `Cache-Control: no-store`. IDs are decimal strings. JSON bodies reject extra fields; query parameters are unsupported. Errors use `{error:{code,message,requestId}}` and never expose stack traces, SQL, paths, credentials or submitted values.

| Method/path                | Request                   | Boundary/result                                                                                       |
| -------------------------- | ------------------------- | ----------------------------------------------------------------------------------------------------- |
| GET /auth/csrf             | none                      | Creates/refreshes an anonymous or authenticated session; returns memory-only CSRF token               |
| POST /auth/login           | email, password           | CSRF + exact Origin; generic 401 for wrong/missing/pending/disabled accounts; rotates cookie and CSRF |
| GET /auth/session          | none                      | Current ACTIVE account, current membership/role/permission context, absolute expiry; 401 otherwise    |
| POST /auth/logout          | {}                        | CSRF; revokes current session and clears cookie                                                       |
| POST /auth/forgot-password | email                     | CSRF + limits; always generic 202 for syntactically valid eligible/ineligible accounts                |
| POST /auth/reset-password  | token, password           | CSRF + limits; expiring single-use token; no automatic login; revokes all user sessions               |
| POST /auth/society-context | societyId: string or null | CSRF + authenticated user; selection must exist in current validated memberships                      |
| GET /platform/access       | none                      | Explicit PLATFORM_ADMIN assignment only; returns authorization context                                |
| GET /society/access        | none                      | Selected current membership + society.dashboard.read; returns authorization context                   |

CSRF applies to login, reset and anonymous state-changing requests too. Retrieve `/auth/csrf` first, then send `X-CSRF-Token`, JSON and the exact `Origin`. SameSite cookies are defense in depth, not the CSRF boundary. Cross-site fetch metadata is rejected. Cookies have Path=/, no Domain, HttpOnly and SameSite=Lax; production additionally uses Secure and the `__Host-` prefix. HTTP development cookies are restricted to an explicit loopback origin.

256-bit random bearer session/reset tokens are stored as SHA-256 hashes; no session identifier is available to frontend JavaScript. CSRF uses a session-bound HMAC and is returned only in a noncacheable response. Authenticated sessions slide for 30 minutes idle, capped at 12 hours absolute. Anonymous sessions expire after 30 minutes absolute. No remember-me. Logout and reset revoke in the database. Each request checks current account status. Migration 007 also revokes all sessions and outstanding reset tokens at the database boundary when status becomes inactive or a password hash changes. Re-enabling an account cannot revive old credentials, even if no request observed disablement. Membership, profile, society and grant changes are re-read each request.

## Authorization policy

PLATFORM_ADMIN assignments live in `platform_user_roles`, separate from tenant roles. There is no tenant bypass, wildcard grant or impersonation route. The same user may have different society roles. Active context is stored server-side; body selection is only a candidate which the server validates against the authenticated user.

Tenant access requires ACTIVE account, ACTIVE unended membership with a nonfuture joined_at, nonarchived society-specific person profile, ACTIVE nonarchived society, and a current nonarchived role. DRAFT/setup/verification/suspended/deactivated societies grant no private workspace access in Step 3. Later onboarding must define narrowly scoped setup permissions explicitly.

Permissions are the intersection of current tenant `role_permissions` grants and the server role ceiling:

| Role             | Maximum permissions                                                                          |
| ---------------- | -------------------------------------------------------------------------------------------- |
| COMMITTEE_ADMIN  | society.dashboard.read, society.finance.read, society.finance.record, society.members.manage |
| COMMITTEE_MEMBER | society.dashboard.read                                                                       |
| ACCOUNTANT       | society.dashboard.read, society.finance.read, society.finance.record                         |
| RESIDENT         | society.dashboard.read                                                                       |

No grants are assumed merely from a role name; missing grant denies access. Unknown roles/permissions and a tenant role named PLATFORM_ADMIN confer no privilege. The development seed explicitly provisions grants. Production role/permission provisioning remains operator-controlled.

`Security.authenticated`, `Security.platform` and `Security.tenant(permission)` are reusable server middleware. Tenant queries must include the validated active society alongside each resource ID; a foreign or nonexistent resource should return the same 404. Nested resource relationships also need composite scoping. For future writes, revalidate and lock account/membership/society inside the mutation transaction to prevent revocation races; middleware alone is not a transaction lock. Step 3 ships no such business mutations.

Identity, CSRF, logout and context selection return only the user's own account/access metadata and allow recovery after membership removal. They re-read memberships but need no tenant permission. A revoked selected membership becomes null; tenant middleware denies access until a valid context is chosen. Frontend guards/hidden links are UX, never a security boundary.

## Runtime DB privileges

A DBA creates the runtime user with a fresh secret and a host limited to the application network. After migration, grant only:

- SELECT on users, societies, society_persons, society_memberships, roles, membership_roles, permissions, role_permissions, platform_user_roles.
- UPDATE(password_hash) on users.
- SELECT/INSERT/UPDATE/DELETE on auth_sessions, password_reset_tokens, auth_rate_limits.
- INSERT on auth_events.

No schema-wide grant, DDL, platform-role writes, status changes, audit updates/deletes or financial reads. Runtime tests prove these denials. Deploy the API with only runtime DB credentials; supply migrator credentials in a separate operator environment and never pass DB_TEST_ADMIN_PASSWORD to the API process. The test-only provisioner uses explicit disposable administrator credentials after validating NODE_ENV=test, loopback and `livora_test_*`; it is excluded from production builds. The real server never uses them.

## Abuse controls, delivery and operations

Shared MySQL fixed-window counters are atomically incremented under transactions and keyed by HMACs rather than raw emails/IPs/tokens. API IP: 120/minute; login IP: 20/15 minutes and account: 5/15 minutes; reset-request IP: 10/15 minutes and account: 3/15 minutes; reset-submission IP: 10/15 minutes and token: 5/15 minutes. Limits persist across instances/restarts. They are temporary throttles, not permanent account locks. 429 has generic text and Retry-After. Deploy a trusted edge limit for distributed abuse and set operational alerts for safe failure codes.

Forgot-password work runs in a bounded in-process queue after the response. Account lookup and SMTP latency do not change the public result. Only ACTIVE accounts already having a password are eligible. A later request invalidates prior tokens. The latest token expires after 30 minutes. Concurrent resets lock the account then token; exactly one can consume it. Password change, all reset-token consumption, session revocation and immutable audit insert commit together.

Queue capacity is 32 pending jobs, one active job; no unbounded memory or secret-bearing persisted mail spool. SMTP/queue failure logs a safe code and correlation ID; successful token generation also records delivery failures. Jobs can be lost on process termination or saturation; users can request a new link. This deliberate limitation avoids storing plaintext reset links. A durable encrypted mail queue can be a separately reviewed later improvement.

Security audit stores action, optional global user, HMAC IP, correlation ID and UTC time only. No email/password/token/request body. It is append-only with triggers and restricted runtime privileges. Operational policy should retain audits only as long as required, with authorized archival outside runtime; no automatic audit deletion. A minute maintenance job deletes at most 1000 expired rate buckets and token/session rows past expiry plus one day. It never deletes users, tenant data or audits. Run maintenance on a designated instance for large deployments.

## Validation

`npm run check` runs format, lint, strict types, offline tests, production build and additive migration validation. `npm run test:db` also runs real HTTP authentication tests against a fresh empty loopback `livora_test_*` schema. It now requires explicit APP_DB_USER, APP_DB_PASSWORD and DB_TEST_ADMIN_PASSWORD for its restricted runtime account. Set these in a dedicated ignored test environment, never production. Database fixtures are retained; each run requires a fresh schema. CI provisions only its disposable MySQL service.

Security tests cover Argon2id parameters, session rotation/replay, idle/absolute expiry, active/disabled/pending accounts, CSRF/origins, validated bodies, current membership/profile/society/permission revocation, tenant role differences, IDOR/BOLA with existing foreign flat IDs through real middleware, platform isolation, concurrent single-use resets, logout, shared rate limits, safe errors/headers/cookies, FKs, append-only audits and runtime privileges. Existing Step 1 tests still run.
