# Constraints, indexes and concurrent writes

Step 5 adds tenant resident references, private CSV review batches/rows and immutable occupancy history without changing this baseline. See [property schema and constraints](PROPERTY_SCHEMA.md) and [management/import security rules](../security/PROPERTY_MANAGEMENT.md).

Every table uses an explicit primary key. Every society-owned table has `society_id → societies.id`, plus `UNIQUE(society_id,id)` so referenced composite keys are genuinely unique under MySQL 8.4. Tenant-to-tenant references always include society_id. Nullable relationships intentionally permit no relation; a non-null resource must be in that society.

All foreign keys use default **RESTRICT/NO ACTION** (immediate InnoDB checks); none cascade or set-null. This is equivalent to restrictive deletion, and omitting explicit referential clauses avoids MySQL CHECK restrictions on columns participating in foreign-key actions. See [MySQL foreign keys](https://dev.mysql.com/doc/refman/8.4/en/create-table-foreign-keys.html) and [CHECK constraints](https://dev.mysql.com/doc/refman/8.4/en/create-table-check-constraints.html).

## Uniqueness and checks

| Area               | Database guarantee                                                                                                                                        |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Global identity    | Unique `users.person_id` and normalized lower/trimmed email (ASCII, case-sensitive after normalization); tenant profile unique `(society_id,person_id)`   |
| Membership/roles   | One membership per society/User; unique role code per society; no duplicate role/permission grants                                                        |
| Property           | Building code unique per society; flat number unique within society/building; positive optional flat area                                                 |
| Occupancy          | End date ≥ start date; allowed type; one open-ended record per society/flat/Person/type via nullable generated marker; closed intervals remain historical |
| Invitations        | Globally unique 32-byte token hash; one pending invitation per society/normalized email; accepted records require acceptor/time; expiry > creation        |
| Registration       | One pending request per society/User; reviewed APPROVED/REJECTED require tenant reviewer/time; no implicit membership activation                          |
| Charges            | Nonnegative DECIMAL rate, positive version; unique type/flat-scope/version; valid effective dates; null flat = society default                            |
| Billing            | Period code and date range unique per society; valid dates; one bill per society/flat/period and unique bill number; issue requires actor/time            |
| Items              | Unique line number per bill, positive quantity, nonnegative unit rate/amount; amount = rounded quantity × rate                                            |
| Payments           | Positive amount; tenant-scoped idempotency key; cash collector required; collector/recorder must be memberships in tenant                                 |
| Allocations        | One payment/bill pair; positive amount; composite keys enforce same tenant **and flat**                                                                   |
| Receipts/reversals | At most one receipt and one full reversal per payment; unique society receipt number/reversal request                                                     |
| Corrections/audit  | Positive bill adjustment, unique request; immutable adjustments, payments, allocations, receipts, reversals and audit rows                                |

Domain state columns use ASCII binary collation and allowed-value CHECKs. SQL constraints cannot prove authenticated intent, membership permissions, ownership or correct legal state transitions.

## Immutability

Migration 005 adds 17 triggers: UPDATE/DELETE blocked for each append-only table; issued bills block UPDATE/DELETE; bill items block INSERT/UPDATE/DELETE when their original or target bill is issued. Item guards lock the parent bill (`FOR UPDATE`) to serialize changes against issuing. Avoid issuing a bill from a multi-table statement that also changes its items; perform ordered statements in a transaction. Runtime DB grants add a second layer and omit UPDATE/DELETE for append-only tables and all DDL/TRIGGER privileges.

The schema freezes completed snapshots; it does **not yet implement** financial services. Original receipts survive full reversals and must be displayed with reversal context. Never treat a payment as unreversed merely because its original row exists.

## Index intent

- Global login email, User→membership/status/society, tenant member uniqueness: authentication and society selection.
- Society→profile/archive, building/flat uniqueness, occupancy flat/date and Person/end: directories and current/history lookups.
- Invitation society/status/expiry, request society/status/created: onboarding queues and expiry handling.
- Charge society/type/effective range; bill society/period/status and society/flat/period: setup and batch billing.
- Payment society/date/id and society/method/reference; allocation society/bill: collection history, duplicate review and outstanding calculations.
- Notice society/status/published/id; complaint society/status/created/id and society/submitter/created: feed and private complaint queues.
- Audit society/created/id and society/entity/id/created: paginated tenant audit lookup.

InnoDB creates required child FK indexes when a declared index does not cover their leading columns. They are intentional, not permission filters. Use EXPLAIN with representative pilot data in later API steps; no claim of production query tuning is made here.

## Required service transactions in later steps

MySQL CHECKs cannot contain cross-row aggregates or subqueries. These boundaries require transactions and later service/integration tests:

1. Lock a flat/profile row before changing occupancy; check interval overlap for that Person/type. Multiple co-owners/tenants are allowed; one open interval per **flat** is deliberately not enforced. Identical closed history may need service duplicate prevention.
2. Lock charge type/scope before version changes; reject overlapping effective ranges. Default and explicit flat overrides coexist; precedence is explicit override, then default. Billing-period overlaps also require society-level serialization.
3. Lock invite/request and User/profile rows; validate expiry and token binding, then activate membership/assign role/append audit atomically. Global unique email handles concurrent account creation; duplicate conflicts re-read existing verified identity.
4. Lock the bill before item changes/issuance; verify SUM(items)=total_amount and the configuration applies to that flat/date. Snapshot items before issuance. Unique flat/period rejects concurrent duplicates.
5. Lock payment, then all affected bills in ascending ID order. Validate issued/unreversed state and allocations against payment amount and outstanding including adjustments; reject over-allocation/overpayment. Insert payment/allocation/receipt/audit in one transaction with the same idempotency key. Unique keys supplement this, but alone do not enforce sums.
6. Lock payment/bills for a full reversal; preserve allocations/receipt and append one reversal plus audit. Outstanding computations exclude reversed payments. Credit corrections cannot make outstanding invalid; enforce it under the same bill locks.

Payment references are indexed **not globally unique**: bank references/cheques may legitimately repeat under different methods or institutions. Later payment services must define a normalized reference policy, flag suspicious duplicates and verify external payments. Idempotency keys protect request retries; a reference alone is not proof of payment.
