# Data dictionary

Step 6 tables and their fields are documented in the [resident access schema](RESIDENT_ACCESS_SCHEMA.md).

Step 5 adds tenant resident references, private CSV review batches/rows and immutable occupancy history without changing this baseline. See [property schema and constraints](PROPERTY_SCHEMA.md) and [management/import security rules](../security/PROPERTY_MANAGEMENT.md).

Step 4 additions are documented in [onboarding schema](ONBOARDING_SCHEMA.md); the baseline below is preserved.

Step 3's five global identity/security tables are documented in the [auth schema extension](AUTH_SCHEMA.md); the 27 domain tables below are preserved.

The committed migration SQL is authoritative for defaults, generated expressions, keys and CHECK predicates. This dictionary covers all 27 domain tables. `NULL` means optional; `NOT NULL` means required. All table IDs and tenant/resource references are BIGINT UNSIGNED. All currency/rates are DECIMAL(12,2); quantities/areas use DECIMAL(10,2). Primary IDs are AUTO_INCREMENT, and creation/modified timestamps use UTC-session CURRENT_TIMESTAMP(6).

`persons`, `users` and `permissions` are global. `societies` is the tenant directory. Every other table has non-null society_id and tenant relationship constraints. Foreign keys never cascade. See [constraints](CONSTRAINTS_AND_INDEXES.md) for scope, uniqueness and service-enforced cross-row invariants.

## societies

Tenant directory, lifecycle and display timezone.

| Column      | SQL definition                                                                     | Meaning                                                                                |
| ----------- | ---------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| id          | `BIGINT UNSIGNED NOT NULL AUTO_INCREMENT`                                          | Opaque internal identifier; BIGINT returned as a string to JavaScript.                 |
| code        | `VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL`                       | Stable scoped code; global only on societies/permissions.                              |
| name        | `VARCHAR(200) NOT NULL`                                                            | Human-readable label.                                                                  |
| timezone    | `VARCHAR(64) NOT NULL DEFAULT 'Asia/Kolkata'`                                      | Validated IANA display timezone in future services, default Asia/Kolkata.              |
| status      | `VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT 'DRAFT'`       | Allowed domain state; database validates values, future services validate transitions. |
| archived_at | `DATETIME(6) NULL`                                                                 | UTC archive instant; null means not archived.                                          |
| created_at  | `DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6)`                                | Creation instant in UTC (session timezone must be +00:00).                             |
| updated_at  | `DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6)` | Last mutation instant in UTC.                                                          |

Checks:

- `CHECK (status IN ('DRAFT', 'SETUP_IN_PROGRESS', 'PENDING_VERIFICATION', 'ACTIVE', 'SUSPENDED', 'DEACTIVATED'))`

## persons

Global opaque Person identity with no PII; may have no User account.

| Column     | SQL definition                                      | Meaning                                                                |
| ---------- | --------------------------------------------------- | ---------------------------------------------------------------------- |
| id         | `BIGINT UNSIGNED NOT NULL AUTO_INCREMENT`           | Opaque internal identifier; BIGINT returned as a string to JavaScript. |
| created_at | `DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6)` | Creation instant in UTC (session timezone must be +00:00).             |

## users

Optional global login identity; one per Person and normalized email.

| Column            | SQL definition                                                                     | Meaning                                                                                |
| ----------------- | ---------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| id                | `BIGINT UNSIGNED NOT NULL AUTO_INCREMENT`                                          | Opaque internal identifier; BIGINT returned as a string to JavaScript.                 |
| person_id         | `BIGINT UNSIGNED NOT NULL`                                                         | Canonical global Person anchor; tenant references go through society_persons.          |
| email_normalized  | `VARCHAR(254) CHARACTER SET ascii COLLATE ascii_bin NOT NULL`                      | Trimmed lowercase ASCII authentication/invitation email.                               |
| password_hash     | `VARCHAR(255) CHARACTER SET ascii COLLATE ascii_bin NULL`                          | Encoded Argon2id/bcrypt credential hash only; null for a pending/no-login fixture.     |
| status            | `VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT 'PENDING'`     | Allowed domain state; database validates values, future services validate transitions. |
| email_verified_at | `DATETIME(6) NULL`                                                                 | UTC email verification instant; future auth must check it.                             |
| created_at        | `DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6)`                                | Creation instant in UTC (session timezone must be +00:00).                             |
| updated_at        | `DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6)` | Last mutation instant in UTC.                                                          |

Checks:

- `CHECK (status IN ('PENDING', 'ACTIVE', 'DISABLED'))`
- `CHECK (email_normalized = LOWER(TRIM(email_normalized)))`

## society_persons

Private tenant resident profile and verified Person-to-society link.

| Column        | SQL definition                                      | Meaning                                                                       |
| ------------- | --------------------------------------------------- | ----------------------------------------------------------------------------- |
| id            | `BIGINT UNSIGNED NOT NULL AUTO_INCREMENT`           | Opaque internal identifier; BIGINT returned as a string to JavaScript.        |
| society_id    | `BIGINT UNSIGNED NOT NULL`                          | Mandatory tenant key; cannot establish authorization by itself.               |
| person_id     | `BIGINT UNSIGNED NOT NULL`                          | Canonical global Person anchor; tenant references go through society_persons. |
| display_name  | `VARCHAR(160) NOT NULL`                             | Tenant-local resident name; not a global directory attribute.                 |
| contact_email | `VARCHAR(254) NULL`                                 | Optional tenant contact address, independent of global login email.           |
| contact_phone | `VARCHAR(32) NULL`                                  | Optional tenant contact number; avoid collecting unnecessary data.            |
| archived_at   | `DATETIME(6) NULL`                                  | UTC archive instant; null means not archived.                                 |
| created_at    | `DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6)` | Creation instant in UTC (session timezone must be +00:00).                    |

## society_memberships

One global User's access relationship to a society.

| Column     | SQL definition                                                                 | Meaning                                                                                |
| ---------- | ------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------- |
| id         | `BIGINT UNSIGNED NOT NULL AUTO_INCREMENT`                                      | Opaque internal identifier; BIGINT returned as a string to JavaScript.                 |
| society_id | `BIGINT UNSIGNED NOT NULL`                                                     | Mandatory tenant key; cannot establish authorization by itself.                        |
| user_id    | `BIGINT UNSIGNED NOT NULL`                                                     | Global login account; never a duplicate account per society.                           |
| status     | `VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT 'PENDING'` | Allowed domain state; database validates values, future services validate transitions. |
| joined_at  | `DATETIME(6) NULL`                                                             | UTC membership activation instant.                                                     |
| ended_at   | `DATETIME(6) NULL`                                                             | UTC membership end instant; preserve membership history.                               |
| created_at | `DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6)`                            | Creation instant in UTC (session timezone must be +00:00).                             |

Checks:

- `CHECK (status IN ('PENDING', 'ACTIVE', 'SUSPENDED', 'DEACTIVATED'))`
- `CHECK (ended_at IS NULL OR (joined_at IS NOT NULL AND ended_at >= joined_at))`

## roles

Tenant-owned role definitions; no implicit platform support privilege.

| Column      | SQL definition                                               | Meaning                                                                |
| ----------- | ------------------------------------------------------------ | ---------------------------------------------------------------------- |
| id          | `BIGINT UNSIGNED NOT NULL AUTO_INCREMENT`                    | Opaque internal identifier; BIGINT returned as a string to JavaScript. |
| society_id  | `BIGINT UNSIGNED NOT NULL`                                   | Mandatory tenant key; cannot establish authorization by itself.        |
| code        | `VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL` | Stable scoped code; global only on societies/permissions.              |
| name        | `VARCHAR(100) NOT NULL`                                      | Human-readable label.                                                  |
| archived_at | `DATETIME(6) NULL`                                           | UTC archive instant; null means not archived.                          |
| created_at  | `DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6)`          | Creation instant in UTC (session timezone must be +00:00).             |

## permissions

Global permission catalog; no default grants are seeded.

| Column      | SQL definition                                                | Meaning                                                                       |
| ----------- | ------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| id          | `BIGINT UNSIGNED NOT NULL AUTO_INCREMENT`                     | Opaque internal identifier; BIGINT returned as a string to JavaScript.        |
| code        | `VARCHAR(100) CHARACTER SET ascii COLLATE ascii_bin NOT NULL` | Stable scoped code; global only on societies/permissions.                     |
| description | `VARCHAR(255) NOT NULL`                                       | Human-readable content; bill_items keeps an immutable issued-charge snapshot. |

## role_permissions

Tenant role to global permission mapping.

| Column        | SQL definition                                      | Meaning                                                                |
| ------------- | --------------------------------------------------- | ---------------------------------------------------------------------- |
| id            | `BIGINT UNSIGNED NOT NULL AUTO_INCREMENT`           | Opaque internal identifier; BIGINT returned as a string to JavaScript. |
| society_id    | `BIGINT UNSIGNED NOT NULL`                          | Mandatory tenant key; cannot establish authorization by itself.        |
| role_id       | `BIGINT UNSIGNED NOT NULL`                          | Role belonging to this society.                                        |
| permission_id | `BIGINT UNSIGNED NOT NULL`                          | Global permission catalog entry.                                       |
| created_at    | `DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6)` | Creation instant in UTC (session timezone must be +00:00).             |

## membership_roles

Tenant membership to tenant role mapping; supports multiple roles.

| Column        | SQL definition                                      | Meaning                                                                |
| ------------- | --------------------------------------------------- | ---------------------------------------------------------------------- |
| id            | `BIGINT UNSIGNED NOT NULL AUTO_INCREMENT`           | Opaque internal identifier; BIGINT returned as a string to JavaScript. |
| society_id    | `BIGINT UNSIGNED NOT NULL`                          | Mandatory tenant key; cannot establish authorization by itself.        |
| membership_id | `BIGINT UNSIGNED NOT NULL`                          | Membership belonging to this society.                                  |
| role_id       | `BIGINT UNSIGNED NOT NULL`                          | Role belonging to this society.                                        |
| created_at    | `DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6)` | Creation instant in UTC (session timezone must be +00:00).             |

## buildings

Society buildings/blocks.

| Column      | SQL definition                                      | Meaning                                                                |
| ----------- | --------------------------------------------------- | ---------------------------------------------------------------------- |
| id          | `BIGINT UNSIGNED NOT NULL AUTO_INCREMENT`           | Opaque internal identifier; BIGINT returned as a string to JavaScript. |
| society_id  | `BIGINT UNSIGNED NOT NULL`                          | Mandatory tenant key; cannot establish authorization by itself.        |
| code        | `VARCHAR(64) NOT NULL`                              | Stable scoped code; global only on societies/permissions.              |
| name        | `VARCHAR(100) NOT NULL`                             | Human-readable label.                                                  |
| archived_at | `DATETIME(6) NULL`                                  | UTC archive instant; null means not archived.                          |
| created_at  | `DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6)` | Creation instant in UTC (session timezone must be +00:00).             |

## flats

Building-specific flat identifier and optional area.

| Column      | SQL definition                                      | Meaning                                                                |
| ----------- | --------------------------------------------------- | ---------------------------------------------------------------------- |
| id          | `BIGINT UNSIGNED NOT NULL AUTO_INCREMENT`           | Opaque internal identifier; BIGINT returned as a string to JavaScript. |
| society_id  | `BIGINT UNSIGNED NOT NULL`                          | Mandatory tenant key; cannot establish authorization by itself.        |
| building_id | `BIGINT UNSIGNED NOT NULL`                          | Building in the same society.                                          |
| flat_number | `VARCHAR(32) NOT NULL`                              | Label unique inside a tenant building.                                 |
| area_sq_ft  | `DECIMAL(10,2) NULL`                                | Optional positive area, not a currency amount.                         |
| archived_at | `DATETIME(6) NULL`                                  | UTC archive instant; null means not archived.                          |
| created_at  | `DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6)` | Creation instant in UTC (session timezone must be +00:00).             |

Checks:

- `CHECK (area_sq_ft IS NULL OR area_sq_ft > 0)`

## flat_occupancies

Person-to-flat relationship with inclusive historical dates.

| Column         | SQL definition                                                                             | Meaning                                                                              |
| -------------- | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------ |
| id             | `BIGINT UNSIGNED NOT NULL AUTO_INCREMENT`                                                  | Opaque internal identifier; BIGINT returned as a string to JavaScript.               |
| society_id     | `BIGINT UNSIGNED NOT NULL`                                                                 | Mandatory tenant key; cannot establish authorization by itself.                      |
| flat_id        | `BIGINT UNSIGNED NOT NULL`                                                                 | Flat in the same society; nullable charge config means default for all flats.        |
| person_id      | `BIGINT UNSIGNED NOT NULL`                                                                 | Canonical global Person anchor; tenant references go through society_persons.        |
| occupancy_type | `VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT 'AUTHORIZED_OCCUPANT'` | OWNER, TENANT, FAMILY_MEMBER or AUTHORIZED_OCCUPANT.                                 |
| starts_on      | `DATE NOT NULL`                                                                            | Inclusive society-local start date.                                                  |
| ends_on        | `DATE NULL`                                                                                | Inclusive end date; null occupancy means open-ended.                                 |
| open_marker    | `TINYINT GENERATED ALWAYS AS (CASE WHEN ends_on IS NULL THEN 1 ELSE NULL END) STORED`      | Generated 1 for open occupancy, otherwise null; preserves multiple closed intervals. |
| created_at     | `DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6)`                                        | Creation instant in UTC (session timezone must be +00:00).                           |

Checks:

- `CHECK (occupancy_type IN ('OWNER', 'TENANT', 'FAMILY_MEMBER', 'AUTHORIZED_OCCUPANT'))`
- `CHECK (ends_on IS NULL OR ends_on >= starts_on)`

## invitations

Hashed-token invitation and decision state for a known tenant profile.

| Column              | SQL definition                                                                                                                                     | Meaning                                                                                |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| id                  | `BIGINT UNSIGNED NOT NULL AUTO_INCREMENT`                                                                                                          | Opaque internal identifier; BIGINT returned as a string to JavaScript.                 |
| society_id          | `BIGINT UNSIGNED NOT NULL`                                                                                                                         | Mandatory tenant key; cannot establish authorization by itself.                        |
| person_id           | `BIGINT UNSIGNED NOT NULL`                                                                                                                         | Canonical global Person anchor; tenant references go through society_persons.          |
| flat_id             | `BIGINT UNSIGNED NULL`                                                                                                                             | Flat in the same society; nullable charge config means default for all flats.          |
| role_id             | `BIGINT UNSIGNED NOT NULL`                                                                                                                         | Role belonging to this society.                                                        |
| email_normalized    | `VARCHAR(254) CHARACTER SET ascii COLLATE ascii_bin NOT NULL`                                                                                      | Trimmed lowercase ASCII authentication/invitation email.                               |
| token_hash          | `BINARY(32) NOT NULL`                                                                                                                              | 32-byte SHA-256 digest of random token; never the raw token.                           |
| status              | `VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT 'PENDING'`                                                                     | Allowed domain state; database validates values, future services validate transitions. |
| expires_at          | `DATETIME(6) NOT NULL`                                                                                                                             | UTC expiration instant; expiry validation still required on acceptance.                |
| accepted_at         | `DATETIME(6) NULL`                                                                                                                                 | UTC acceptance instant, mandatory only when ACCEPTED.                                  |
| accepted_by_user_id | `BIGINT UNSIGNED NULL`                                                                                                                             | Verified global accepting account; service must validate Person/email binding.         |
| created_by_user_id  | `BIGINT UNSIGNED NOT NULL`                                                                                                                         | Global actor; permits explicit platform onboarding, not implicit support access.       |
| pending_email       | `VARCHAR(254) CHARACTER SET ascii COLLATE ascii_bin GENERATED ALWAYS AS (CASE WHEN status = 'PENDING' THEN email_normalized ELSE NULL END) STORED` | Generated email only while PENDING; null for historic invitations.                     |
| created_at          | `DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6)`                                                                                                | Creation instant in UTC (session timezone must be +00:00).                             |

Checks:

- `CHECK (status IN ('PENDING', 'ACCEPTED', 'EXPIRED', 'REVOKED'))`
- `CHECK (email_normalized = LOWER(TRIM(email_normalized)))`
- `CHECK (expires_at > created_at)`
- `CHECK ((status = 'ACCEPTED' AND accepted_at IS NOT NULL AND accepted_by_user_id IS NOT NULL) OR (status <> 'ACCEPTED' AND accepted_at IS NULL AND accepted_by_user_id IS NULL))`

## registration_requests

Pending self-registration request; confers no access.

| Column                    | SQL definition                                                                                         | Meaning                                                                                |
| ------------------------- | ------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------- |
| id                        | `BIGINT UNSIGNED NOT NULL AUTO_INCREMENT`                                                              | Opaque internal identifier; BIGINT returned as a string to JavaScript.                 |
| society_id                | `BIGINT UNSIGNED NOT NULL`                                                                             | Mandatory tenant key; cannot establish authorization by itself.                        |
| user_id                   | `BIGINT UNSIGNED NOT NULL`                                                                             | Global login account; never a duplicate account per society.                           |
| requested_flat_id         | `BIGINT UNSIGNED NOT NULL`                                                                             | Requested tenant flat, validated during review.                                        |
| requested_occupancy_type  | `VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT 'AUTHORIZED_OCCUPANT'`             | Proposed occupancy type; not verified entitlement.                                     |
| status                    | `VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT 'PENDING'`                         | Allowed domain state; database validates values, future services validate transitions. |
| reviewed_by_membership_id | `BIGINT UNSIGNED NULL`                                                                                 | Reviewer in this society; permission and active-state checks required.                 |
| reviewed_at               | `DATETIME(6) NULL`                                                                                     | UTC decision instant required for approval/rejection.                                  |
| decision_note             | `VARCHAR(500) NULL`                                                                                    | Safe decision reason; do not expose sensitive reviewer details.                        |
| pending_user_id           | `BIGINT UNSIGNED GENERATED ALWAYS AS (CASE WHEN status = 'PENDING' THEN user_id ELSE NULL END) STORED` | Generated User key while PENDING, allowing historical requests afterward.              |
| created_at                | `DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6)`                                                    | Creation instant in UTC (session timezone must be +00:00).                             |

Checks:

- `CHECK (requested_occupancy_type IN ('OWNER', 'TENANT', 'FAMILY_MEMBER', 'AUTHORIZED_OCCUPANT'))`
- `CHECK (status IN ('PENDING', 'APPROVED', 'REJECTED', 'CANCELLED'))`
- `CHECK ((status IN ('APPROVED', 'REJECTED') AND reviewed_at IS NOT NULL AND reviewed_by_membership_id IS NOT NULL) OR (status IN ('PENDING', 'CANCELLED') AND reviewed_at IS NULL AND reviewed_by_membership_id IS NULL))`

## maintenance_charge_types

Tenant maintenance categories.

| Column      | SQL definition                                               | Meaning                                                                |
| ----------- | ------------------------------------------------------------ | ---------------------------------------------------------------------- |
| id          | `BIGINT UNSIGNED NOT NULL AUTO_INCREMENT`                    | Opaque internal identifier; BIGINT returned as a string to JavaScript. |
| society_id  | `BIGINT UNSIGNED NOT NULL`                                   | Mandatory tenant key; cannot establish authorization by itself.        |
| code        | `VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL` | Stable scoped code; global only on societies/permissions.              |
| name        | `VARCHAR(100) NOT NULL`                                      | Human-readable label.                                                  |
| archived_at | `DATETIME(6) NULL`                                           | UTC archive instant; null means not archived.                          |
| created_at  | `DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6)`          | Creation instant in UTC (session timezone must be +00:00).             |

## maintenance_charge_configurations

Versioned default/flat-specific rates with date validity.

| Column             | SQL definition                                                                   | Meaning                                                                                  |
| ------------------ | -------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| id                 | `BIGINT UNSIGNED NOT NULL AUTO_INCREMENT`                                        | Opaque internal identifier; BIGINT returned as a string to JavaScript.                   |
| society_id         | `BIGINT UNSIGNED NOT NULL`                                                       | Mandatory tenant key; cannot establish authorization by itself.                          |
| charge_type_id     | `BIGINT UNSIGNED NOT NULL`                                                       | Charge category in this society.                                                         |
| flat_id            | `BIGINT UNSIGNED NULL`                                                           | Flat in the same society; nullable charge config means default for all flats.            |
| calculation_method | `VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT 'FLAT_RATE'` | FLAT_RATE or PER_SQ_FT; service defines rounding/calculation policy.                     |
| rate               | `DECIMAL(12,2) NOT NULL`                                                         | Nonnegative DECIMAL(12,2) monetary rate.                                                 |
| effective_from     | `DATE NOT NULL`                                                                  | Inclusive society-local effective date.                                                  |
| effective_until    | `DATE NULL`                                                                      | Inclusive local end date, or null for open configuration.                                |
| version            | `INT UNSIGNED NOT NULL`                                                          | Positive version; unique for charge type and flat/default scope.                         |
| flat_scope         | `BIGINT UNSIGNED GENERATED ALWAYS AS (COALESCE(flat_id, 0)) STORED`              | Generated COALESCE(flat_id,0) distinguishes a default config from explicit flat configs. |
| created_at         | `DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6)`                              | Creation instant in UTC (session timezone must be +00:00).                               |

Checks:

- `CHECK (calculation_method IN ('FLAT_RATE', 'PER_SQ_FT'))`
- `CHECK (rate >= 0 AND version > 0)`
- `CHECK (effective_until IS NULL OR effective_until >= effective_from)`

## billing_periods

Society-local billing calendar and due date.

| Column     | SQL definition                                               | Meaning                                                                |
| ---------- | ------------------------------------------------------------ | ---------------------------------------------------------------------- |
| id         | `BIGINT UNSIGNED NOT NULL AUTO_INCREMENT`                    | Opaque internal identifier; BIGINT returned as a string to JavaScript. |
| society_id | `BIGINT UNSIGNED NOT NULL`                                   | Mandatory tenant key; cannot establish authorization by itself.        |
| code       | `VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL` | Stable scoped code; global only on societies/permissions.              |
| starts_on  | `DATE NOT NULL`                                              | Inclusive society-local start date.                                    |
| ends_on    | `DATE NOT NULL`                                              | Inclusive end date; null occupancy means open-ended.                   |
| due_on     | `DATE NOT NULL`                                              | Society-local calendar due date.                                       |
| created_at | `DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6)`          | Creation instant in UTC (session timezone must be +00:00).             |

Checks:

- `CHECK (ends_on >= starts_on AND due_on >= starts_on)`

## bills

Per-flat, per-period bill; frozen after issuance.

| Column                  | SQL definition                                                               | Meaning                                                                                |
| ----------------------- | ---------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| id                      | `BIGINT UNSIGNED NOT NULL AUTO_INCREMENT`                                    | Opaque internal identifier; BIGINT returned as a string to JavaScript.                 |
| society_id              | `BIGINT UNSIGNED NOT NULL`                                                   | Mandatory tenant key; cannot establish authorization by itself.                        |
| billing_period_id       | `BIGINT UNSIGNED NOT NULL`                                                   | Billing calendar in this society.                                                      |
| flat_id                 | `BIGINT UNSIGNED NOT NULL`                                                   | Flat in the same society; nullable charge config means default for all flats.          |
| bill_number             | `VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL`                 | Tenant-unique human-readable bill identifier.                                          |
| status                  | `VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT 'DRAFT'` | Allowed domain state; database validates values, future services validate transitions. |
| total_amount            | `DECIMAL(12,2) NOT NULL`                                                     | Frozen issued total DECIMAL(12,2); must equal sum of items before issuance.            |
| issued_at               | `DATETIME(6) NULL`                                                           | UTC issue instant.                                                                     |
| issued_by_membership_id | `BIGINT UNSIGNED NULL`                                                       | Issuer membership in this society.                                                     |
| created_at              | `DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6)`                          | Creation instant in UTC (session timezone must be +00:00).                             |

Checks:

- `CHECK (status IN ('DRAFT', 'ISSUED'))`
- `CHECK (total_amount >= 0)`
- `CHECK ((status = 'ISSUED' AND issued_at IS NOT NULL AND issued_by_membership_id IS NOT NULL) OR (status = 'DRAFT' AND issued_at IS NULL AND issued_by_membership_id IS NULL))`

## bill_items

Charge calculation snapshots; frozen with the parent bill.

| Column                  | SQL definition                                      | Meaning                                                                           |
| ----------------------- | --------------------------------------------------- | --------------------------------------------------------------------------------- |
| id                      | `BIGINT UNSIGNED NOT NULL AUTO_INCREMENT`           | Opaque internal identifier; BIGINT returned as a string to JavaScript.            |
| society_id              | `BIGINT UNSIGNED NOT NULL`                          | Mandatory tenant key; cannot establish authorization by itself.                   |
| bill_id                 | `BIGINT UNSIGNED NOT NULL`                          | Bill in this society (allocations additionally enforce the same flat).            |
| charge_configuration_id | `BIGINT UNSIGNED NOT NULL`                          | Source configuration; service checks date/flat applicability before snapshotting. |
| line_number             | `SMALLINT UNSIGNED NOT NULL`                        | Positive unique line number within bill.                                          |
| description             | `VARCHAR(255) NOT NULL`                             | Human-readable content; bill_items keeps an immutable issued-charge snapshot.     |
| quantity                | `DECIMAL(10,2) NOT NULL`                            | Positive calculation quantity, not a currency amount.                             |
| unit_rate               | `DECIMAL(12,2) NOT NULL`                            | Snapshot monetary rate, DECIMAL(12,2).                                            |
| amount                  | `DECIMAL(12,2) NOT NULL`                            | DECIMAL(12,2) financial amount; positivity/nonnegativity depends on table.        |
| created_at              | `DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6)` | Creation instant in UTC (session timezone must be +00:00).                        |

Checks:

- `CHECK (quantity > 0 AND unit_rate >= 0 AND amount >= 0 AND line_number > 0)`
- `CHECK (amount = ROUND(quantity * unit_rate, 2))`

## bill_adjustments

Append-only credit/debit correction for an issued bill.

| Column                    | SQL definition                                                                | Meaning                                                                                     |
| ------------------------- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| id                        | `BIGINT UNSIGNED NOT NULL AUTO_INCREMENT`                                     | Opaque internal identifier; BIGINT returned as a string to JavaScript.                      |
| society_id                | `BIGINT UNSIGNED NOT NULL`                                                    | Mandatory tenant key; cannot establish authorization by itself.                             |
| bill_id                   | `BIGINT UNSIGNED NOT NULL`                                                    | Bill in this society (allocations additionally enforce the same flat).                      |
| direction                 | `VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT 'CREDIT'` | CREDIT reduces billed value, DEBIT increases it; adjustment does not rewrite original bill. |
| amount                    | `DECIMAL(12,2) NOT NULL`                                                      | DECIMAL(12,2) financial amount; positivity/nonnegativity depends on table.                  |
| reason                    | `VARCHAR(500) NOT NULL`                                                       | Safe correction/reversal reason; required audit context.                                    |
| idempotency_key           | `VARCHAR(80) CHARACTER SET ascii COLLATE ascii_bin NOT NULL`                  | Tenant-unique operation key for retries; never use a raw session/access token.              |
| recorded_by_membership_id | `BIGINT UNSIGNED NOT NULL`                                                    | Tenant member who digitally recorded the collection/correction.                             |
| created_at                | `DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6)`                           | Creation instant in UTC (session timezone must be +00:00).                                  |

Checks:

- `CHECK (direction IN ('CREDIT', 'DEBIT'))`
- `CHECK (amount > 0)`

## payments

Completed recorded collection; no gateway or claimed-payment model.

| Column                     | SQL definition                                                              | Meaning                                                                                 |
| -------------------------- | --------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| id                         | `BIGINT UNSIGNED NOT NULL AUTO_INCREMENT`                                   | Opaque internal identifier; BIGINT returned as a string to JavaScript.                  |
| society_id                 | `BIGINT UNSIGNED NOT NULL`                                                  | Mandatory tenant key; cannot establish authorization by itself.                         |
| flat_id                    | `BIGINT UNSIGNED NOT NULL`                                                  | Flat in the same society; nullable charge config means default for all flats.           |
| payer_person_id            | `BIGINT UNSIGNED NOT NULL`                                                  | Tenant resident profile via (society_id,person_id); account not required.               |
| method                     | `VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT 'CASH'` | CASH, UPI, BANK_TRANSFER, CHEQUE or OTHER.                                              |
| payment_date               | `DATE NOT NULL`                                                             | Society-local date of physical/external collection, not an instant.                     |
| amount                     | `DECIMAL(12,2) NOT NULL`                                                    | DECIMAL(12,2) financial amount; positivity/nonnegativity depends on table.              |
| reference                  | `VARCHAR(128) NULL`                                                         | Optional external reference/cheque/UTR text; indexed, deliberately not globally unique. |
| collected_by_membership_id | `BIGINT UNSIGNED NULL`                                                      | Tenant physical collector; required for CASH, optional for external transfers.          |
| recorded_by_membership_id  | `BIGINT UNSIGNED NOT NULL`                                                  | Tenant member who digitally recorded the collection/correction.                         |
| notes                      | `VARCHAR(1000) NULL`                                                        | Optional safe collection context; never credentials or unnecessary financial data.      |
| idempotency_key            | `VARCHAR(80) CHARACTER SET ascii COLLATE ascii_bin NOT NULL`                | Tenant-unique operation key for retries; never use a raw session/access token.          |
| created_at                 | `DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6)`                         | Creation instant in UTC (session timezone must be +00:00).                              |

Checks:

- `CHECK (method IN ('CASH', 'UPI', 'BANK_TRANSFER', 'CHEQUE', 'OTHER'))`
- `CHECK (amount > 0)`
- `CHECK (method <> 'CASH' OR collected_by_membership_id IS NOT NULL)`

## payment_allocations

Completed allocation between payment and bill in the same flat.

| Column     | SQL definition                                      | Meaning                                                                       |
| ---------- | --------------------------------------------------- | ----------------------------------------------------------------------------- |
| id         | `BIGINT UNSIGNED NOT NULL AUTO_INCREMENT`           | Opaque internal identifier; BIGINT returned as a string to JavaScript.        |
| society_id | `BIGINT UNSIGNED NOT NULL`                          | Mandatory tenant key; cannot establish authorization by itself.               |
| payment_id | `BIGINT UNSIGNED NOT NULL`                          | Recorded payment in this society.                                             |
| bill_id    | `BIGINT UNSIGNED NOT NULL`                          | Bill in this society (allocations additionally enforce the same flat).        |
| flat_id    | `BIGINT UNSIGNED NOT NULL`                          | Flat in the same society; nullable charge config means default for all flats. |
| amount     | `DECIMAL(12,2) NOT NULL`                            | DECIMAL(12,2) financial amount; positivity/nonnegativity depends on table.    |
| created_at | `DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6)` | Creation instant in UTC (session timezone must be +00:00).                    |

Checks:

- `CHECK (amount > 0)`

## payment_reversals

Append-only full-payment reversal; original ledger survives.

| Column                    | SQL definition                                               | Meaning                                                                        |
| ------------------------- | ------------------------------------------------------------ | ------------------------------------------------------------------------------ |
| id                        | `BIGINT UNSIGNED NOT NULL AUTO_INCREMENT`                    | Opaque internal identifier; BIGINT returned as a string to JavaScript.         |
| society_id                | `BIGINT UNSIGNED NOT NULL`                                   | Mandatory tenant key; cannot establish authorization by itself.                |
| payment_id                | `BIGINT UNSIGNED NOT NULL`                                   | Recorded payment in this society.                                              |
| reason                    | `VARCHAR(500) NOT NULL`                                      | Safe correction/reversal reason; required audit context.                       |
| reversed_by_membership_id | `BIGINT UNSIGNED NOT NULL`                                   | Tenant actor recording a full reversal.                                        |
| idempotency_key           | `VARCHAR(80) CHARACTER SET ascii COLLATE ascii_bin NOT NULL` | Tenant-unique operation key for retries; never use a raw session/access token. |
| created_at                | `DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6)`          | Creation instant in UTC (session timezone must be +00:00).                     |

## receipts

One immutable receipt per payment.

| Column                  | SQL definition                                               | Meaning                                                                |
| ----------------------- | ------------------------------------------------------------ | ---------------------------------------------------------------------- |
| id                      | `BIGINT UNSIGNED NOT NULL AUTO_INCREMENT`                    | Opaque internal identifier; BIGINT returned as a string to JavaScript. |
| society_id              | `BIGINT UNSIGNED NOT NULL`                                   | Mandatory tenant key; cannot establish authorization by itself.        |
| payment_id              | `BIGINT UNSIGNED NOT NULL`                                   | Recorded payment in this society.                                      |
| receipt_number          | `VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL` | Tenant-unique immutable receipt identifier.                            |
| issued_at               | `DATETIME(6) NOT NULL`                                       | UTC issue instant.                                                     |
| issued_by_membership_id | `BIGINT UNSIGNED NOT NULL`                                   | Issuer membership in this society.                                     |
| created_at              | `DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6)`          | Creation instant in UTC (session timezone must be +00:00).             |

## notices

Tenant community notice content and publish state.

| Column                   | SQL definition                                                               | Meaning                                                                                |
| ------------------------ | ---------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| id                       | `BIGINT UNSIGNED NOT NULL AUTO_INCREMENT`                                    | Opaque internal identifier; BIGINT returned as a string to JavaScript.                 |
| society_id               | `BIGINT UNSIGNED NOT NULL`                                                   | Mandatory tenant key; cannot establish authorization by itself.                        |
| title                    | `VARCHAR(200) NOT NULL`                                                      | Display title; render safely, without trusted HTML assumptions.                        |
| body                     | `TEXT NOT NULL`                                                              | Notice content; future UI must sanitize/render safely.                                 |
| status                   | `VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT 'DRAFT'` | Allowed domain state; database validates values, future services validate transitions. |
| published_at             | `DATETIME(6) NULL`                                                           | UTC publish instant; required for PUBLISHED notices.                                   |
| created_by_membership_id | `BIGINT UNSIGNED NOT NULL`                                                   | Tenant author; later service verifies active permissions.                              |
| created_at               | `DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6)`                          | Creation instant in UTC (session timezone must be +00:00).                             |

Checks:

- `CHECK (status IN ('DRAFT', 'PUBLISHED', 'ARCHIVED'))`
- `CHECK (status <> 'PUBLISHED' OR published_at IS NOT NULL)`

## complaints

Tenant flat-linked private complaint; future services enforce user-specific visibility.

| Column                     | SQL definition                                                              | Meaning                                                                                |
| -------------------------- | --------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| id                         | `BIGINT UNSIGNED NOT NULL AUTO_INCREMENT`                                   | Opaque internal identifier; BIGINT returned as a string to JavaScript.                 |
| society_id                 | `BIGINT UNSIGNED NOT NULL`                                                  | Mandatory tenant key; cannot establish authorization by itself.                        |
| submitted_by_membership_id | `BIGINT UNSIGNED NOT NULL`                                                  | Tenant complaint author; future services scope private reads to authorized actors.     |
| flat_id                    | `BIGINT UNSIGNED NOT NULL`                                                  | Flat in the same society; nullable charge config means default for all flats.          |
| title                      | `VARCHAR(200) NOT NULL`                                                     | Display title; render safely, without trusted HTML assumptions.                        |
| description                | `TEXT NOT NULL`                                                             | Human-readable content; bill_items keeps an immutable issued-charge snapshot.          |
| status                     | `VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT 'OPEN'` | Allowed domain state; database validates values, future services validate transitions. |
| resolved_at                | `DATETIME(6) NULL`                                                          | UTC informational resolution instant; future status-history logic is deferred.         |
| archived_at                | `DATETIME(6) NULL`                                                          | UTC archive instant; null means not archived.                                          |
| created_at                 | `DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6)`                         | Creation instant in UTC (session timezone must be +00:00).                             |

Checks:

- `CHECK (status IN ('OPEN', 'IN_PROGRESS', 'RESOLVED', 'CLOSED'))`

## audit_logs

Append-only tenant security/financial evidence with minimal safe metadata.

| Column        | SQL definition                                                | Meaning                                                                                            |
| ------------- | ------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| id            | `BIGINT UNSIGNED NOT NULL AUTO_INCREMENT`                     | Opaque internal identifier; BIGINT returned as a string to JavaScript.                             |
| society_id    | `BIGINT UNSIGNED NOT NULL`                                    | Mandatory tenant key; cannot establish authorization by itself.                                    |
| actor_user_id | `BIGINT UNSIGNED NULL`                                        | Optional global authenticated actor; null for system actions, scoped authorization still required. |
| action        | `VARCHAR(100) CHARACTER SET ascii COLLATE ascii_bin NOT NULL` | Allowlisted security/financial action code in future services.                                     |
| entity_type   | `VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL`  | Allowlisted logical resource type; polymorphic subject needs service scope validation.             |
| entity_id     | `BIGINT UNSIGNED NULL`                                        | Opaque subject ID; no polymorphic FK, so validate tenant scope before logging.                     |
| request_id    | `VARCHAR(80) CHARACTER SET ascii COLLATE ascii_bin NOT NULL`  | Safe correlation identifier, not a secret or authentication token.                                 |
| safe_metadata | `JSON NULL`                                                   | Optional JSON allowlist of minimal safe facts; no raw requests, tokens or PII snapshots.           |
| created_at    | `DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6)`           | Creation instant in UTC (session timezone must be +00:00).                                         |

## _schema_migrations (operator metadata)

| Column     | Definition                               | Meaning                                  |
| ---------- | ---------------------------------------- | ---------------------------------------- |
| version    | INT UNSIGNED PRIMARY KEY                 | Ordered migration version                |
| name       | VARCHAR(255) ASCII binary NOT NULL       | Exact committed filename                 |
| checksum   | CHAR(64) ASCII binary NOT NULL           | SHA-256 over normalized LF SQL           |
| status     | VARCHAR(16) ASCII binary NOT NULL        | STARTED or APPLIED; STARTED blocks rerun |
| started_at | DATETIME(6) DEFAULT CURRENT_TIMESTAMP(6) | UTC execution start                      |
| applied_at | DATETIME(6) NULL                         | UTC completion marker                    |

The runtime application must have no grants on metadata. The runner owns status updates. Token/PII values never belong in this table.
