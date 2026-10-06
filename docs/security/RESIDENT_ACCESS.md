# Step 6: resident access and security

Committee administrators with an active selected society and `society.members.manage` can invite an existing person and decide registration requests. Every operation rechecks the live session, membership, role, lifecycle and tenant scope inside its transaction. Platform scope alone grants no resident access. Invitations and approvals assign **RESIDENT only**; clients cannot choose a role, user, audit actor or society for committee operations.

## Identity and approval

Person remains distinct from User. New accounts verify email before creation, using Argon2id passwords and the existing cookie/CSRF authentication. Verification creates no society profile, membership or occupancy and does not log the user in. An existing account signs in and submits the same pending join request; its password and global Person remain unchanged.

The authenticated join flow offers bounded, rate-limited search over active society names/codes and active address labels so applicants do not need to transcribe internal codes. Address results are scoped to the selected society and distinguish flats from row houses. The lookup returns no resident, occupancy, membership or financial data and is unavailable without an active account. Submission still sends the selected society code, building code and flat number as a claim; the server independently resolves only an active, unarchived address, records PENDING plus the applicant's submitted details and appends an audit event. It creates no membership, role, profile or occupancy. The applicant can see/cancel only their own paginated requests. There is no public resident directory.

Approval requires an explicit verification attestation and a note. The committee chooses the correct tenant Person or a profile for the applicant's existing global Person, the approved flat, type and dates, and either explicitly selects a matching current occupancy or creates one using Step 5 overlap rules. Historical/future-only occupancy cannot establish current access. In one transaction it links the person, creates the unique Resident membership, records occupancy/reviewer/time/decision and appends audit. Rejection/cancellation create no access. Completed decisions are immutable.

`membership_person_links` deliberately records an approved identity association when a committee-created Person differs from a login's original global Person. It is not an automatic identity merge: the original User, global Person, occupancies, references and financial records stay unchanged. Unique tenant keys prevent sharing that profile among memberships. A Person already belonging to another global account cannot be claimed. Legacy memberships use their User's original Person when no explicit link exists. Auth and management joins honor the explicit link and the tenant profile's archive state.

Matching name, email or mobile does not merge people during registration. Approval requires committee verification against its records. Phone is validated contact information, not an authentication factor; no SMS verification service is implemented. Email possession alone is not sufficient to claim a flat.

## Invitations and tokens

The committee selects an existing, unarchived person with a normalized contact email and a current occupancy in the selected active flat/building. The server fixes the intended action to RESIDENT_JOIN and the role to RESIDENT. The token has 32 cryptographically random bytes; only its SHA-256 digest is stored. It expires in 72 hours and must still be PENDING at acceptance.

Acceptance rechecks the society, intended action, role, person, current contact email and occupancy. Existing users must sign in with the exact invited email and may not supply a replacement password. A new account proves email possession through the mailed token and creates its password against the intended Person. No account lookup flag is returned by token inspection, and invalid, used, wrong-account, revoked and expired links return the same safe error. Setup invitations and signup verification tokens belong to different tables/endpoints and cannot be exchanged.

Resend creates a new invitation and revokes/expires its predecessor; it never changes or reuses the old hash. Accepted invitations cannot be resent/revoked. Lists retain invitation history for archived residents/roles without making those records eligible for acceptance or resend, and surface effective EXPIRED status immediately; bounded background maintenance also persists expiry. Delivery status is QUEUED/SENT/FAILED. Revoke/resend reasons are retained in tenant audit metadata. SMTP uses the existing authenticated, certificate-verified TLS transport. The bounded in-process queue can lose unsent jobs on a crash: committee delivery status and resend are the recovery path; a signup user can request another email. No paid provider or speculative queue service was added.

Signup returns identical 202 instructions for existing/new accounts. Account lookup, hashing and SMTP happen after the public response in a bounded queue. Existing-email instructions go only to that mailbox and never replace its password. Email verification tokens expire after 30 minutes, are hashed and single-use, and scrub email/name/password hash on consumption or expiry. Account verification appends a separate immutable global event because the earlier auth event table has a fixed action vocabulary.

Tokens are sent as URL fragments, stripped from history on load and held only in component memory. Users reopen the email link after signing in. They are never stored in localStorage, logged, returned in committee lists or committed in fixtures. All API responses use no-store and the PWA caches only static shells/assets.

## Threat model and limits

Assets are credentials, tokens, tenant profiles/occupancies, membership grants and immutable decision evidence. Trust boundaries are the browser/API, session-selected tenant, SMTP mailbox and restricted runtime/database. Attackers include anonymous callers, unapproved users, residents, foreign committees and platform operators without tenant permission.

Mitigations cover token guessing/replay/action confusion, email/account enumeration, mass assignment, BOLA, unauthorized flat claims, duplicate accounts and concurrent decisions. Per 15-minute window: signup 10/IP and 3/email; verification 10/IP and 5/token; invitation inspection/acceptance 10/IP per action and acceptance 5/token; committee invitation create/resend/revoke share 5/user/society; join requests 5/user. The existing general API limit, secure cookies, strict origins, CSRF, safe errors and request limits remain enabled. Valid tokens cannot override disabled accounts or archived profiles/societies. SQL uses parameterized values; lists use fixed ordering and 20-row pages.

Society write locks serialize invite/approval mutations; token/request row locks and unique global email/person and tenant membership keys provide additional protection. Deadlock/duplicate conflicts roll back and produce safe 409 responses. Cross-tenant references use composite foreign keys. Runtime grants do not include financial reads, membership-link changes, audit changes or DDL. Do not clear rate limits or broaden grants to make a test pass.

Verification mail is a mailbox-possession check; committee identity/residency review remains a human responsibility. Deploy with HTTPS, approved SMTP delivery and a reviewed PII/decision retention policy. Long-term evidence is retained; no purge/merge of existing data is implemented.

The token and enumeration controls follow [OWASP's token guidance](https://cheatsheetseries.owasp.org/cheatsheets/Forgot_Password_Cheat_Sheet.html) and [email verification guidance](https://cheatsheetseries.owasp.org/cheatsheets/Email_Validation_and_Verification_Cheat_Sheet.html).

## API contracts and rollout

All paths below have the `/api/v1` prefix. All POSTs require the same-origin JSON/CSRF contract, including anonymous token and signup flows.

| Endpoint                                                | Body/access                                                                                                            |
| ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| POST /resident-access/account/start                     | email, password (15–128 characters), displayName; uniform 202                                                          |
| POST /resident-access/account/verify                    | token; creates global login only                                                                                       |
| POST /resident-access/invitations/inspect               | token; minimal invitation metadata, no account existence flag                                                          |
| POST /resident-access/invitations/accept                | token, optional password for a new account only                                                                        |
| GET /resident-access/requests                           | authenticated applicant; page/status                                                                                   |
| POST /resident-access/requests                          | societyCode, buildingCode, flatNumber, occupancyType, displayName, contactPhone/null, note/null                        |
| GET /resident-access/join-options/societies             | authenticated, bounded active society name/code search; no tenant-private data                                         |
| GET /resident-access/join-options/properties            | authenticated, selected societyCode plus bounded active flat/row-house address search                                  |
| POST /resident-access/requests/:id/cancel               | owner only; confirmed:true, note                                                                                       |
| GET /society/resident-invitations                       | committee; page/status                                                                                                 |
| POST /society/resident-invitations                      | committee; personId, flatId, confirmed:true                                                                            |
| POST /society/resident-invitations/:id/resend or revoke | committee; confirmed:true, note                                                                                        |
| GET /society/registration-requests                      | committee; page/status; includes society-local today                                                                   |
| POST /society/registration-requests/:id/approve         | committee; confirmed:true, note, personId/null, flatId, existingOccupancyId/null, occupancyType, startsOn, endsOn/null |
| POST /society/registration-requests/:id/reject          | committee; confirmed:true, note                                                                                        |

Apply additive migrations 010–011 with the migrator, then the column-specific grants in `src/database/resident-access-grants.ts`, before deploying the new backend. Original migrations 001–009 remain unchanged; historical rows without Step 6 detail records are retained. The managed Windows runner's additive upgrade handles both migrations/grants after a stop/start. Never point integration tests at the managed manual schema or production.
