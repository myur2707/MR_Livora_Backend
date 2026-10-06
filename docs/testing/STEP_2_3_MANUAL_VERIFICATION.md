# Steps 2 and 3 manual verification — 2026-10-02

This is a verification of the current Steps 1–5 application against the requested Step 2 and Step 3 checklist. No later feature, business API or migration was added. The previous implementation reports remain historical snapshots.

The managed application runs at **http://127.0.0.1:4200**, with Express on port 3000, owned MySQL 8.4.8 on port 3307 and the local Mailpit inbox on port 8025. Existing XAMPP on port 3306 and the initial manual-account passwords were preserved. Synthetic verification accounts and fresh integration schemas are retained; no database, table or existing domain data was dropped.

## Step 2

| Requested check            | Executed evidence                                                                                                                                                                                                | Result |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| Local routes               | Live platform dashboard/directory, society dashboard, workspace, login, forgot/reset, shared controls and not-found pages; the browser suite also exercises each lazy route with explicit authorization fixtures | PASS   |
| Sidebar/mobile/keyboard    | Collapse/expand, 320px navigation with Enter, focused route headings, dialog/drawer Tab/Shift+Tab/Escape and focus restoration                                                                                   | PASS   |
| Theme/contrast/focus       | Light/dark route accessibility checks, theme persistence and keyboard focus                                                                                                                                      | PASS   |
| Production manifest/worker | Production build and `pwa:check`: manifest/icons, hashed static assets, no data groups/runtime URL caching, private-navigation bypass                                                                            | PASS   |
| Install and open PWA       | Installed Chrome 154 into an isolated local profile, then launched the installed app and asserted standalone display mode and the login heading                                                                  | PASS   |
| Unknown route              | A clear not-found page with a return link                                                                                                                                                                        | PASS   |
| Offline/static assets      | Static gallery/login remains available; protected authorization and API data require the network                                                                                                                 | PASS   |
| Private cache exclusion    | Worker-cache inspection excludes real API responses and synthetic bills/payments/receipts/residents/uploads/private-JS/property paths; private offline fetches fail                                              | PASS   |
| Invalid form               | Visible required-field errors associated using labels, IDs, aria-describedby and aria-invalid; safe server-error feedback                                                                                        | PASS   |

The installed profile is under `MR_Livora_Frontend/.local-tools/step23-pwa-profile`. It is separate from the user's normal Chrome profile. The ignored `MR_Livora_Frontend/.local-tools/Open-Mr. Livora-PWA.ps1` launches the preserved installation while the local services are running. Installation used Chrome's [DevTools PWA commands](https://github.com/ChromeDevTools/devtools-protocol/blob/master/json/browser_protocol.json); it does not establish behavior of every browser/device installation menu.

A populated society directory exposed page-level horizontal overflow at 320px. Positioned screen-reader text escaped the table's scroll boundary. The frontend now contains that text within the table and makes the existing table scroll areas named, keyboard-focusable regions. A populated-table regression exercises narrow layout, arrow-key scrolling and focusing a previously off-screen link. The existing axe checks also cover empty import-history tables.

## Step 3

| Requested check                          | Executed evidence                                                                                                                                                                                                    | Result                   |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------ |
| Login/logout                             | Actual UI login; logout rejects a copied session cookie; database suite checks rotation and hashed session storage                                                                                                   | PASS                     |
| Reset/new password                       | Actual UI and authenticated STARTTLS delivery into local Mailpit; a synthetic account avoids changing initial manual passwords; 30-minute hashed token, old-password/session rejection and single-use replay failure | PASS                     |
| Committee permissions                    | Real Green Meadows committee access and denied platform scope; permission/membership revocation takes effect on the next request in isolated HTTP tests                                                              | PASS                     |
| Switch society/roles                     | Same real user switches from Green Meadows COMMITTEE_ADMIN to Blue Heights RESIDENT; management API returns 403 and management UI redirects                                                                          | PASS                     |
| Enumeration-safe login/reset             | Existing, missing, disabled and pending accounts return identical safe failures; forgot-password responses are generic                                                                                               | PASS                     |
| Expired/reused reset                     | Isolated HTTP tests reject expired, replaced and reused links; concurrent redemption yields one success and one rejection                                                                                            | PASS                     |
| Repeated login/reset                     | Isolated concurrent account/IP tests return 429 and retain limits across independent service instances; live user limits were preserved                                                                              | PASS                     |
| Anonymous request                        | Protected API returns 401 in both live and isolated checks                                                                                                                                                           | PASS                     |
| Insufficient permission                  | Resident management/platform scope returns 403                                                                                                                                                                       | PASS                     |
| Forged IDs/roles                         | Extra society_id/user_id/flat_id/role fields return 400; unowned society selection returns 403; forged scope headers never grant access                                                                              | PASS                     |
| Cross-society operations                 | Existing foreign flat: real read/update/archive return 404 and row comparison confirms unchanged data; unsupported physical DELETE returns 404                                                                       | PASS                     |
| CSRF                                     | Missing/mismatched tokens and foreign origins reject login/reset/logout/context changes; protected mutations enforce CSRF                                                                                            | PASS                     |
| Session expiry                           | Idle and absolute expiry cannot be extended beyond their configured bounds; account disablement revokes sessions                                                                                                     | PASS                     |
| Production cookie configuration          | Isolated production-mode proxy test asserts __Host name, Path=/, Secure, HttpOnly, SameSite=Lax and no Domain; insecure transport is rejected                                                                        | PASS in test environment |
| Cookies on an actual deployed HTTPS host | No deployed HTTPS URL/configuration was supplied                                                                                                                                                                     | NOT EXECUTED             |

Physical deletion is intentionally unsupported: archive preserves occupancy/financial/audit history. Rejection of DELETE therefore proves that route is unavailable, while cross-tenant archive exercises the implemented removal behavior. Tenant finance APIs are not implemented; no financial data was exposed or cached to manufacture a test.

Local HTTP uses the documented loopback development cookie. The production-mode cookie assertions do not verify an operator's actual TLS termination, proxy trust or deployed browser cookies. Verify those against the intended HTTPS deployment using an authorized test account.

## Executed quality gates

- Backend `npm run check`: format, lint, strict typecheck, **19 offline tests**, build and validation of **9 additive migrations** passed.
- Fresh owned MySQL schema: **54 integration tests** passed, including authentication/authorization, migrations and preserved Step 1–5 boundaries.
- Frontend `npm run check`: format, lint, strict application/template/test/tool typecheck, **21 unit tests**, **3 proxy tests**, production build and PWA assertions passed.
- Final frontend browser suite: **18 tests passed**, including the populated-table keyboard/overflow regression and existing import accessibility checks.
- Both complete dependency audits: **0 reported vulnerabilities**.
- Tracked source/history and staged changes: no secrets found; `git diff --check` passed.

The automated total is **115 passing tests**. Live browser/API/SMTP and installed-PWA checks are additional probes. Backend migrations 001–009 are unchanged.

Local verification scripts, browser profiles, screenshots, credentials and mail contents are ignored. Credentials/tokens were used only inside the test processes and were not printed or committed. Rate-limit tests ran on isolated services; no live limits were cleared or disabled.
