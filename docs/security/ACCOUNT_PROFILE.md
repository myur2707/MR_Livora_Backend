# Account profile security

The account profile contains the authenticated user's preferred display name and optional contact
phone. It is global to the login account and is deliberately separate from tenant-owned,
committee-verified `society_persons` data, memberships, roles, and occupancy history.

The authenticated user is the only actor allowed to read or update this profile. The server derives
the user identifier from the HttpOnly session; it never accepts a user or society identifier from
the request. Updates require CSRF protection, use a strict field allowlist and bounded validation,
and execute as parameterized SQL. Platform administrators receive no additional profile access.

Primary abuse cases are mass assignment, cross-account access, stored control characters, and
unaudited personal-data changes. Mitigations are session-derived ownership, strict request parsing,
length and character checks, least-privilege table grants, and immutable `account_profile_events`.
The application does not copy these values into verified society records. Profiles are retained with
the account; deletion or retention changes require a separately reviewed account-lifecycle policy.
