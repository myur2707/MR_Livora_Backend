# Tenant isolation and Step 1 threat model

Step 6's tenant identity links, approval permissions and global email verification boundary are documented in the [resident access threat model](../security/RESIDENT_ACCESS.md).

Step 5 adds tenant resident references, private CSV review batches/rows and immutable occupancy history without changing this baseline. See [property schema and constraints](PROPERTY_SCHEMA.md) and [management/import security rules](../security/PROPERTY_MANAGEMENT.md).

Assets: tenant resident contact/occupancy data, accounts, bills/collections/receipts, roles/grants, onboarding tokens, private complaints and audit history. Actors: unauthenticated applicant, resident, committee/accountant, explicitly scoped platform operator, migration operator and compromised runtime account. Boundaries: browser→future API, authenticated identity→active society, service→SQL, migration credentials→DDL, and global identity→tenant profile.

| Abuse case                                        | Mitigation / boundary                                                                                                                              |
| ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Client replaces society/flat/Person/collector ID  | Derive tenant from validated active membership; allowlist resource queries; composite tenant FKs reject cross-tenant relationships                 |
| Read/export another society's rows                | Every repository query must include authenticated society predicate and authorized resource relationship; indexes/FKs do not filter SELECT results |
| Guess a global User/Person                        | Tenant residents resolve through society_persons and memberships; no tenant-facing global directory; opaque Person anchor contains no PII          |
| Self-register to get resident/admin access        | Pending requests confer no membership or role; verified committee approval required                                                                |
| Reuse/steal invite token                          | Cryptographic random token, store SHA-256 digest only, unique digest, expiry and single-use compare-and-set in a transaction; never log token      |
| Change a role or record cash as another collector | Server permission checks plus tenant membership FKs; verify actor is active and authorized, not merely present                                     |
| Duplicate bill/payment/receipt during races       | Tenant unique keys/idempotency plus prescribed locks/transactions; enforce aggregate rules in services                                             |
| Erase financial/audit evidence                    | No cascade deletes, append-only triggers, restricted runtime grants and audited corrections/reversals                                              |
| Platform support browses all finances             | No automatic platform grant in schema; future support authorization must be explicit, tenant-scoped, bounded and audited                           |
| Credentials/error leakage                         | Placeholder config, ignored secrets, remote verified TLS, safe CLI messages; never return driver SQL/stack traces to clients                       |
| DBA alters tables/triggers                        | DB privileges cannot defend against a trusted DBA; external backup/access review and restricted deployment credentials required                    |

## Schema relationships

Global tables: `persons`, `users`, `permissions`; `societies` is the tenant directory. `_schema_migrations` is operator-only. All other tables have a non-null society_id and a tenant FK. Every tenant resource FK references `(society_id,id)`; resident references use `(society_id,person_id)` on society_persons. The allocation's additional flat key prevents pairing bills/payments for different flats even inside one tenant.

Global actor references in invitations/audit_logs intentionally allow a platform onboarding actor and a system actor (null audit User). They identify who acted, **do not confer access**, and require explicit support/onboarding authorization later. Financial actors reference tenant memberships. Historical deactivated memberships remain valid evidence; future write authorization checks active status at operation time.

Membership does not repeat person_id; transactionally create/validate the society_persons link through users.person_id before activating. An authenticated User may have different roles per society. Choose active society only after membership validation, never from an untrusted header alone.

## Future repository contract (illustrative, not an implemented API)

```sql
SELECT b.id, b.bill_number, b.total_amount
FROM bills b
WHERE b.society_id = ? AND b.id = ? AND b.flat_id = ?;
```

All values are bound using mysql2.execute; the society and allowed flats are derived from identity and authorization. List/export/count/join queries require the same scope. Pagination is capped; dynamic sorting uses an allowlist. No spread of request bodies into SQL fields. Cross-tenant FK tests verify writes; future authenticated endpoint tests must verify reads and user-specific access.

MySQL shared-schema tables have no automatic row-level security here. A compromised application credential can SELECT any row its table grants allow. Restrict network and DB credentials; centralize scoped data access and review every query. This baseline is not a completed authorization system.

Runtime grants must be explicit per table. The application cannot ALTER/DROP/CREATE/TRIGGER/GRANT or access _schema_migrations. It may INSERT/SELECT append-only financial/audit tables, and may UPDATE only mutable tables required by a reviewed module. Ordinary application users never directly access MySQL.

PWA caching, cookie sessions/CSRF, request validation, rate limits, file controls and private resident read scopes are future API/PWA gates; Step 1 introduces no endpoints, caches or uploads.

Step 7 adds immutable charge metadata, period kinds, generation idempotency, bill snapshots, audited discount policy and one-time event consumption. See [billing schema](BILLING_SCHEMA.md) for all seven supporting tables, composite foreign keys, indexes and guards, and [approved billing rules](../billing/STEP_7_BILLING.md) for full monthly amounts without proration and informational arrears. Applied migrations 001?011 and existing financial history remain unchanged.

Step 8 migration 013 adds immutable receipt snapshots, physical refunds with original-allocation links, reversal dates and canonical command completion without rewriting applied migrations or baseline payments. See [payment schema](PAYMENT_SCHEMA.md) for tables/FKs/checks/indexes/guards, [payment policies and safe rollout](../billing/STEP_8_PAYMENTS.md) and [payment threat model](../security/PAYMENTS.md). Outstanding now subtracts released refunds from effective nonreversed payments; no writable cached balance or cascade deletion is added.
