# Resident onboarding data contract

Step 5 adds tenant resident references, private CSV review batches/rows and immutable occupancy history without changing this baseline. See [property schema and constraints](PROPERTY_SCHEMA.md) and [management/import security rules](../security/PROPERTY_MANAGEMENT.md).

This is the baseline data-contract design. Step 6 now implements resident invitations and pending registration approval; see [the current API/security contract](../security/RESIDENT_ACCESS.md) and [additive schema](RESIDENT_ACCESS_SCHEMA.md). Current invitations grant RESIDENT only, require a verified current occupancy and use explicit tenant identity links when an existing global account's Person differs. Read the general workflow below with those stricter implemented rules.

## Committee-created or imported resident without login

Create a Person identity and its society_persons profile, then date-bounded flat_occupancies. No User or membership is required. Owners, tenants, family members and authorized occupants may coexist, including multiple owners/tenants. End prior intervals rather than overwrite/delete them. Verify duplicate resident identity manually; a matching name/contact is not proof of global identity.

## Invitation of an existing resident

1. Authorized committee/onboarding operator identifies tenant profile, optional flat and intended tenant role. Validate the actor, society lifecycle and role's allowed privileges server-side.
2. Generate a cryptographically random token (at least 32 random bytes), persist only its SHA-256 digest in BINARY(32), normalized recipient email, expiry and PENDING state. Delivering tokens is outside this step; no paid integration is added.
3. Before issuing another pending invite for an email, lock and explicitly expire/revoke the stale one. The generated pending-email unique key prevents races; wall-clock expiry alone does not automatically change status.
4. Acceptance locks the invite and verifies digest, PENDING status, expiry and verified recipient identity. Link the invitation's Person to the User only after verified identity confirmation. If the email's existing account maps to another Person, require reviewed reconciliation of the tenant profile/occupancy; do not automatically merge identities or create a duplicate account.
5. In one transaction, ensure the User's Person has the tenant profile, reuse/create unique membership, assign validated tenant role, mark ACCEPTED with acceptor/time, and append audit. Failure rolls back all DML. A used, expired or revoked invite confers no access.

States: PENDING, ACCEPTED, EXPIRED, REVOKED. A User can join another society through an existing global account. Invitation role assignment must not permit resident self-escalation.

## Resident self-registration

Use a verified global User and insert a PENDING registration_request for a validated tenant flat and proposed occupancy type. No active membership, profile access or role grant follows from this request. A second pending request for the same society/User fails; rejected/cancelled historical requests remain recorded.

An authorized committee reviewer validates residency and requested flat, locks the request/User/target flat, then ensures the correct Person profile, records occupancy, creates/updates membership and authorized resident role, marks APPROVED with tenant reviewer/time and appends audit transactionally. REJECTED records have reviewer/time and a safe decision note. CANCELLED is permitted only to the applicant before decision; actor authorization is a future service responsibility.

States: PENDING, APPROVED, REJECTED, CANCELLED. The database requires review metadata for approvals/rejections, but it cannot authorize the reviewer or confirm real-world ownership. Generic responses and rate limiting must prevent account enumeration/abuse in the later API step.

## History and privacy

Deactivate membership to withdraw login access; archive society_persons to remove directory visibility. End occupancy with a date; do not delete past owners/tenants. Historic bills/payments remain flat-based evidence, never dependent on a current tenant link. New residents must not automatically gain access to another Person's historical private receipts merely because they now occupy the flat; later authorization needs occupancy dates and document ownership policy.

Only collect useful tenant contact details. Global Person contains no PII. Global login email changes do not automatically rewrite tenant contact profiles. PII erasure/reconciliation needs identity verification and reviewed retention policy; immutable finance/audit links remain opaque, with safe minimal metadata.
