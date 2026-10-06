# Local manual testing on Windows

The managed setup runs the implemented Steps 1–5 locally: the database, Angular shared components/PWA, cookie sessions, login/logout, password reset, roles and society switching. Step 4 adds limited platform metadata, initial society setup and committee verification. Step 5 adds building/flat/resident management, occupancy history and reviewed CSV imports. Steps 6?8 also provide verified resident access, maintenance billing and payment recording/receipts/returns/reports; notices and complaints remain later steps. See [Step 8 verification and retained demo](STEP_8_VERIFICATION.md).

## Start, stop and restart

From this backend repository in PowerShell:

```powershell
npm run local:setup   # First time only: isolated database, accounts, local inbox; starts everything
npm run local:start   # Subsequent starts; existing services and accounts are reused
npm run local:status
npm run local:stop    # Stops only recorded/verified local processes; preserves all data
```

The workspace also contains a portable Node installation. If your global npm uses old Node, call the PowerShell script directly; it selects the correct portable Node:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/local.ps1 start
```

From the parent workspace use the path MR_Livora_Backend/scripts/local.ps1. Services run in the background, so closing the terminal does not stop them. After changing code, stop and start again to rebuild both projects. Starting an already running setup checks it without duplicating processes.

| Service                                            | Address                                  |
| -------------------------------------------------- | ---------------------------------------- |
| Angular production PWA                             | http://127.0.0.1:4200                    |
| API (normally accessed through the frontend proxy) | http://127.0.0.1:3000/api/v1             |
| Local reset-email inbox                            | http://127.0.0.1:8025                    |
| Dedicated MySQL 8.4                                | 127.0.0.1:3307, schema livora_dev_manual |

Use exactly **127.0.0.1:4200**, matching APP_ORIGIN. localhost is a different origin and state-changing requests will fail CSRF checks. The API root has no dashboard; use the Angular address.

## MySQL connection alongside XAMPP

The inspected XAMPP installation runs MariaDB 10.4.24 on port 3306. Mr. Livora requires MySQL 8.4; keep the managed MySQL instance on port 3307 alongside XAMPP. XAMPP can remain running. Starting XAMPP does not start Mr. Livora's separate MySQL instance; use `npm run local:start` for the application services.

For a new MySQL client connection, use:

| Setting                                  | Value                                                                                     |
| ---------------------------------------- | ----------------------------------------------------------------------------------------- |
| Host                                     | `127.0.0.1`                                                                               |
| Port                                     | `3307`                                                                                    |
| Database / default schema                | `livora_dev_manual`                                                                       |
| Database inspection / migration username | `livora_manual_migrator`                                                                  |
| Password                                 | Read `DB_PASSWORD` from the backend's ignored `.env`; do not use the XAMPP root password. |

The backend is already configured with `DB_HOST=127.0.0.1`, `DB_PORT=3307` and `DB_NAME=livora_dev_manual`. `DB_USER`/`DB_PASSWORD` belong to the migration account; the API uses the separately restricted `APP_DB_USER=livora_manual_app` and `APP_DB_PASSWORD`. Do not switch the API to root or grant runtime access to migration history simply to browse it. Database passwords differ from application login passwords.

Run `npm run db:migrate` and `npm run db:status` from the backend repository to safely apply pending additive migrations and verify checksums. Verification on 4 October 2026: MySQL 8.4.8, all 14 migrations applied, zero pending; the migration command applied zero new migrations. Runtime access and the frontend API proxy were verified successfully. Existing schemas and accounts were preserved.

Open `http://127.0.0.1:4200` to use the app. Application credentials are in `.local-db/manual/TEST_ACCOUNTS.md`; no database credentials or application passwords belong in Git.

## Accounts

### Current fresh QA reset (4 October 2026)

The authorized reset rebuilt only `livora_dev_manual` on MySQL port 3307, after creating a verified full SQL backup under `.local-db/manual/backups/qa-reset-2026-10-04-47370cce`. All 14 migrations were reapplied; 59 tables and 75 migration-defined triggers were verified. Previous societies, memberships, residents, occupancies, invitations, bills, payments, receipts and audit history were removed. XAMPP/MariaDB and other schemas were untouched.

Only a fresh `platform@example.invalid` Platform Admin account was recreated, with no society membership. Its new random password is in the ignored `.local-db/manual/TEST_ACCOUNTS.md`; previous credentials are obsolete. Login/logout and the empty platform dashboard were checked, and tenant financial access remains denied. New sessions and security events are created by normal app use.

The account list below describes the original development demonstration fixture; those sample accounts and societies are **not present** in the fresh QA database. Create QA societies through the Platform Admin onboarding screens. Do not rerun demonstration seeds unless sample data is deliberately wanted.

Open the ignored local file **.local-db/manual/TEST_ACCOUNTS.md** for the randomly generated initial password. No passwords are committed or printed by setup.

| Email                      | Expected access                                      |
| -------------------------- | ---------------------------------------------------- |
| platform@example.invalid   | Platform admin, no implicit society membership       |
| admin@example.invalid      | Green Meadows committee admin                        |
| member@example.invalid     | Green Meadows committee member                       |
| accountant@example.invalid | Green Meadows accountant                             |
| resident@example.invalid   | Green Meadows resident                               |
| multi@example.invalid      | Green Meadows committee admin; Blue Heights resident |
| disabled@example.invalid   | Login rejected with the generic login error          |
| pending@example.invalid    | Login rejected with the generic login error          |

All accounts are synthetic and share one randomly generated initial **local-only** password. Resetting a password changes only that account. The credentials file records initial passwords and is not automatically rewritten after resets.

The fixture also creates building A / flat 101 with a person-only owner, a current person-only tenant and a historical tenant. Log in as the Green Meadows committee admin and open the Buildings, Flats and Residents routes to inspect these records and occupancy history. Runtime credentials cannot read financial tables. Platform APIs never expose resident names or charge rates.

For the society wizard, follow [Step 4 manual testing](../../../MR_Livora_Frontend/docs/STEP_4_ONBOARDING.md); for directories and imports, follow [Step 5](../../../MR_Livora_Frontend/docs/STEP_5_PROPERTY_MANAGEMENT.md). A stop/start applies pending additive migrations through 009 and their narrow local runtime grants without replacing existing data/accounts.

## Manual checklist

1. Log in as each active role. Confirm the workspace chooser and role labels. Platform admin can open platform routes, while a resident cannot.
2. Log in as multi@example.invalid. Select Green Meadows, then use the header workspace link to select Blue Heights. Confirm the different roles and selected society.
3. Sign out. Reload a protected route and confirm login is required. Wrong passwords, disabled/pending accounts and nonexistent accounts must produce a generic login error.
4. Request a reset for resident@example.invalid at /forgot-password. Open the inbox at port 8025 and follow its link. Choose a new password of at least 15 characters, confirm it, then log in. The old password and reused reset link must fail. Keep the new password locally for subsequent tests.
5. Request a reset for a nonexistent/disabled account. The UI response remains generic and no reset email arrives.
6. Visit /ui to inspect controls, tables/pagination, validation, dialogs, drawers, toast and loading/empty/error states. Test keyboard navigation, small mobile widths and light/dark theme.
7. In Chrome/Edge, wait for the service worker to activate (refresh once), then use the browser install button/menu. Test offline on public /login or /ui after visiting it. Authenticated data and authorization remain network-dependent; no private API response belongs in Cache Storage.

Rate limits are active: five login attempts per account per 15 minutes, three reset requests per account per 15 minutes, plus IP limits. If deliberately testing rejection repeatedly, wait for the limit window before retrying. Setup/start does not reset rate limits, users or passwords.

## Configuration and safety

- The pre-existing XAMPP service on port 3306 is untouched. Setup binds a separate MySQL 8.4.8 instance only to loopback port 3307.
- Data, local credentials, the old .env backup, mail inbox, certificates and process records live in ignored .local-db/manual. The app consumes the generated ignored .env with separate migrator/runtime credentials.
- Setup initializes only a newly created data directory and schema. It checks MySQL's actual datadir before provisioning. It never drops, truncates or overwrites existing database data. Completed setup is reused. An incomplete setup requires inspection rather than blind destructive cleanup.
- The SMTP capture service uses authenticated STARTTLS. The backend process trusts its specific local certificate through NODE_EXTRA_CA_CERTS; certificate validation and requireTLS remain enabled. The certificate lasts one year and must be renewed locally after expiry.
- Mailpit captures mail locally; no real email is sent. Its UI/API and SMTP listener bind to loopback. Its auth file and private key are ignored. The official [Mailpit SMTP documentation](https://mailpit.axllent.org/docs/configuration/smtp/) describes authenticated STARTTLS.
- The production frontend preview forwards only /api requests to the explicitly configured loopback backend, preserves cookies/Origin/CSRF headers and forces no-store. Test fixtures and proxy mode cannot be enabled together. Service-worker caching remains limited to static assets.
- Stop validates executable, command line and creation time before managing recorded processes. MySQL shutdown is graceful; it retains data. No automatic startup task, global Node changes, container service or firewall changes are installed.

## Tools and troubleshooting

The workspace-local runner expects these existing portable directories in ../.local-tools:

- node-v24.21.0-win-x64 (Node 24 and bundled npm)
- mysql-8.4.8-winx64 (official MySQL distribution)

First setup downloads Mailpit v1.31.3 from its official GitHub release and verifies the archive SHA-256 before extracting into ../.local-tools/mailpit-v1.31.3. It uses OpenSSL from XAMPP (C:/xampp_2/apache/bin/openssl.exe) or Git for Windows to generate the local SMTP certificate. Dependencies are installed with npm ci only when node_modules is absent. On another machine, install these prerequisites first or use the standard README manual configuration.

If a port is occupied by an unrelated service, the runner refuses to stop it. Inspect `.local-db/manual/*.stdout.log`, `*.stderr.log` and `mysql-server.log`. Do not share settings.json, .env, smtp-auth.txt, admin-client.ini or the credentials file. To restore your previous local configuration, first stop this setup and copy its saved `previous-*.env.bak` back to .env.

The managed frontend serves a production build. Restart the setup after code changes to rebuild it. The separate standard `npm run dev` workflow supports live editing; run one frontend server on port 4200 at a time.

## Current manual verification

The [Step 2/3 checklist report](STEP_2_3_MANUAL_VERIFICATION.md) records **115 passing automated tests**, real browser/API and local TLS SMTP reset checks, an actual Chrome PWA installation/standalone launch, the table keyboard/mobile fix, and the remaining deployed-HTTPS cookie check. The installed app uses an isolated Chrome profile; the ignored frontend `.local-tools/Open-Mr. Livora-PWA.ps1` reopens it while services are running. Initial manual-account passwords were preserved.

## Initial local setup verification on 2026-10-02

The following is the original local-setup snapshot, before Steps 4–5 and the later checklist verification.

Both repositories passed format, lint, strict typecheck and production build. All 74 automated tests passed: 11 backend offline tests, 35 fresh-MySQL integrity/auth tests, 15 Angular unit tests, 3 local proxy tests and 10 browser tests. Dependency audits reported zero vulnerabilities, and the local source secret scan found no leaks.

The running manual setup was separately verified through Chromium: role accounts, disabled/pending rejection, two-society switching, platform isolation, HttpOnly/SameSite cookies, actual authenticated STARTTLS delivery into Mailpit, password reset/single use and restoration of the initial test password, static offline gallery and absence of private API caches. All seven migrations are applied; rerunning migration applies zero changes. The person-only owner/current/historical tenant fixtures exist.

Stop/start and repeated setup were exercised successfully with retained data and accounts. XAMPP on port 3306 remained running. Production/repeated direct provisioning attempts were rejected before database operations. Browser installability checks passed; the OS install interaction is available for manual testing.
