# Step 9 resident portal

The portal is an independent read projection of existing society records, plus resident complaint submission. It reuses cookie authentication, approved identity links, occupancy history and exact billing/payment balances. It creates no login, membership, occupancy or financial record automatically.

## Approved privacy policy

Every operation validates the live session/user, selected society, ACTIVE society and membership, a nonarchived effective tenant person, and `society.dashboard.read` within the role capability ceiling. `membership_person_links` takes precedence over the global user's person; no identity inference by name or phone occurs. Platform privilege alone grants no portal access. Committee members can use these routes for their own occupancy, without receiving committee-wide records.

Flats require a current approved occupancy: `starts_on <= today` and no end date or `ends_on >= today`, inclusive in the society timezone. All four occupancy types qualify. Archived buildings/flats are excluded. Only the person's own current occupancy entries are returned; other occupants and contact details are omitted.

Issued bills require that same current occupancy and a billing-period start within its inclusive start/end dates. Earlier occupants' bills, drafts and flats without current occupancy are hidden. Ending occupancy removes bill access on the next local day; ending it before today removes access immediately. This policy was explicitly selected by the user. Aggregate credits/payments against an authorized bill determine its outstanding amount; individual payer or committee details are omitted. Full monthly charges and prior rounding rules remain unchanged.

Payment history and receipts require `payment.payer_person_id = effective tenant person`, within the selected society. Another payer's receipt remains inaccessible even in the same authorized flat. Own historical receipts remain available after occupancy ends while the membership/person/society remain active. Receipt allocations expose bill numbers and amounts, not links granting access to otherwise hidden bills. Reversals/refunds remain visible as historical status/amount/date/method. Recorder/collector identities, internal notes, refund reasons, audit and discount reasons are omitted.

Notices are published, society-wide records with a publication timestamp no later than now. Drafts, archived statuses and scheduled notices are hidden. Audience-specific publishing and committee complaint handling are outside Step 9.

Complaints are visible only to the membership that submitted them, including its own history after occupancy ends. Submission requires a currently authorized flat and derives society, submitter and audit actor from authentication. No update, assignment, resolution or deletion endpoint is added. Profile displays only the linked tenant person's verified contacts plus the user's own login email; corrections go through the committee and password changes use the existing reset flow.

## API contract

All routes use `/api/v1/society/resident`. GETs require authentication and the above authorization policy; responses use the existing `Cache-Control: no-store` policy. Foreign and inaccessible resource identifiers return the same safe 404; absent/inactive society access returns 403, expired sessions 401, stale selected-society requests 409 `CONTEXT_CHANGED`.

| Method / suffix                      | Response or input                                                                        |
| ------------------------------------ | ---------------------------------------------------------------------------------------- |
| GET `/dashboard`                     | Society name/timezone, current due, overdue, recent own payment, three published notices |
| GET `/profile`                       | Own display name, community contact email/phone, login email, society name/timezone      |
| GET `/flats`, `/flats/:id`           | Authorized flat labels/area; detail includes own current occupancy types/dates           |
| GET `/bills`, `/bills/:id`           | Issued bills, exact totals/outstanding; detail adds immutable charge items               |
| GET `/payments`, `/receipts`         | Own payment history; receipts list requires an issued receipt                            |
| GET `/payments/:id/receipt`          | Own receipt, original allocation amounts, refund amounts and return status               |
| GET `/notices`, `/notices/:id`       | Published society-wide notice title/body/timestamp                                       |
| GET `/complaints`, `/complaints/:id` | Own complaint history/status/details                                                     |
| POST `/complaints`                   | Strict `{flatId,title,description}`; returns 201 `{id}`                                  |

Lists accept `page` (1–10,000) and `pageSize` (1–50, default 20), return `{items,total,page,pageSize}`, and order by descending identifier. Bill lists additionally allow authorized `flatId` and `status=ALL|OUTSTANDING|SETTLED`. Unknown query/body fields are rejected. Complaint titles are trimmed, 1–200 characters; descriptions 1–4,000 characters with ordinary multiline text. No HTML rendering is enabled. Creation requires CSRF and is limited to ten attempts per user per hour, in addition to existing request limits. Insert and append-only audit occur in one transaction. An uncertain network outcome should be checked in history before retrying; complaint creation does not claim idempotency.

Amounts remain decimal strings and authoritative operations reuse DECIMAL/BigInt rules. Due-on today is current due; strictly earlier is overdue. Instants use UTC; occupancy, payment and billing DATE fields are society-local calendar dates. Profile/notice/complaint text is plain text.

## Database and rollout

No migration is introduced. All thirteen existing migrations, tables, foreign keys, finance snapshots and append-only rules are retained. Runtime needs the existing identity/occupancy/finance SELECT grants plus:

```sql
GRANT SELECT ON your_schema.notices TO 'your_runtime_user'@'your_runtime_host';
GRANT SELECT, INSERT ON your_schema.complaints TO 'your_runtime_user'@'your_runtime_host';
```

Use an authorized database administrator to substitute explicitly reviewed deployment identifiers. The API must never receive administrator credentials. `src/database/resident-portal-grants.ts` centralizes the two narrow grants for the guarded local upgrader and disposable integration provisioner; it refuses root/invalid targets. It grants no complaint UPDATE/DELETE or notice writes.

For the configured Windows stack, finish tests, then run `npm run local:stop` followed by `npm run local:start`. The runner rebuilds both repositories, applies zero new migrations, updates runtime grants and preserves accounts/passwords and prior records. It touches only the owned instance on port 3307. Do not recreate a shared schema or rerun destructive provisioning.

Use development-only fixtures in a new empty `livora_test_*` schema for published notices and linked occupancy/payment examples. Do not publish synthetic data into production or reset existing manual-test credentials. See [security](../security/RESIDENT_PORTAL.md) and [verification](../testing/STEP_9_VERIFICATION.md).
