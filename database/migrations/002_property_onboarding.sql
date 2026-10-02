-- Additive baseline. Default foreign-key actions are RESTRICT / NO ACTION.
-- Execute through the migration runner; each boundary separates a whole statement.

CREATE TABLE buildings (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  society_id BIGINT UNSIGNED NOT NULL,
  code VARCHAR(64) NOT NULL,
  name VARCHAR(100) NOT NULL,
  archived_at DATETIME(6) NULL,
  UNIQUE KEY uq_buildings_code (society_id, code),
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (id),
  UNIQUE KEY uq_buildings_scope (society_id, id),
  CONSTRAINT fk_buildings_society FOREIGN KEY (society_id) REFERENCES societies (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_ci;

-- statement-breakpoint

CREATE TABLE flats (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  society_id BIGINT UNSIGNED NOT NULL,
  building_id BIGINT UNSIGNED NOT NULL,
  flat_number VARCHAR(32) NOT NULL,
  area_sq_ft DECIMAL(10,2) NULL,
  archived_at DATETIME(6) NULL,
  UNIQUE KEY uq_flats_number (society_id, building_id, flat_number),
  CHECK (area_sq_ft IS NULL OR area_sq_ft > 0),
  CONSTRAINT fk_flats_building FOREIGN KEY (society_id, building_id) REFERENCES buildings (society_id, id),
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (id),
  UNIQUE KEY uq_flats_scope (society_id, id),
  CONSTRAINT fk_flats_society FOREIGN KEY (society_id) REFERENCES societies (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_ci;

-- statement-breakpoint

CREATE TABLE flat_occupancies (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  society_id BIGINT UNSIGNED NOT NULL,
  flat_id BIGINT UNSIGNED NOT NULL,
  person_id BIGINT UNSIGNED NOT NULL,
  occupancy_type VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT 'AUTHORIZED_OCCUPANT',
  CHECK (occupancy_type IN ('OWNER', 'TENANT', 'FAMILY_MEMBER', 'AUTHORIZED_OCCUPANT')),
  starts_on DATE NOT NULL,
  ends_on DATE NULL,
  open_marker TINYINT GENERATED ALWAYS AS (CASE WHEN ends_on IS NULL THEN 1 ELSE NULL END) STORED,
  UNIQUE KEY uq_flat_occupancies_open (society_id, flat_id, person_id, occupancy_type, open_marker),
  KEY ix_flat_occupancies_flat_dates (society_id, flat_id, starts_on, ends_on),
  KEY ix_flat_occupancies_person (society_id, person_id, ends_on),
  CHECK (ends_on IS NULL OR ends_on >= starts_on),
  CONSTRAINT fk_occupancies_flat FOREIGN KEY (society_id, flat_id) REFERENCES flats (society_id, id),
  CONSTRAINT fk_occupancies_person FOREIGN KEY (society_id, person_id) REFERENCES society_persons (society_id, person_id),
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (id),
  UNIQUE KEY uq_flat_occupancies_scope (society_id, id),
  CONSTRAINT fk_flat_occupancies_society FOREIGN KEY (society_id) REFERENCES societies (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_ci;

-- statement-breakpoint

CREATE TABLE invitations (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  society_id BIGINT UNSIGNED NOT NULL,
  person_id BIGINT UNSIGNED NOT NULL,
  flat_id BIGINT UNSIGNED NULL,
  role_id BIGINT UNSIGNED NOT NULL,
  email_normalized VARCHAR(254) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  token_hash BINARY(32) NOT NULL,
  status VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT 'PENDING',
  CHECK (status IN ('PENDING', 'ACCEPTED', 'EXPIRED', 'REVOKED')),
  expires_at DATETIME(6) NOT NULL,
  accepted_at DATETIME(6) NULL,
  accepted_by_user_id BIGINT UNSIGNED NULL,
  created_by_user_id BIGINT UNSIGNED NOT NULL,
  pending_email VARCHAR(254) CHARACTER SET ascii COLLATE ascii_bin GENERATED ALWAYS AS (CASE WHEN status = 'PENDING' THEN email_normalized ELSE NULL END) STORED,
  UNIQUE KEY uq_invitations_token (token_hash),
  UNIQUE KEY uq_invitations_pending (society_id, pending_email),
  KEY ix_invitations_expiry (society_id, status, expires_at),
  CHECK (email_normalized = LOWER(TRIM(email_normalized))),
  CHECK (expires_at > created_at),
  CHECK ((status = 'ACCEPTED' AND accepted_at IS NOT NULL AND accepted_by_user_id IS NOT NULL) OR (status <> 'ACCEPTED' AND accepted_at IS NULL AND accepted_by_user_id IS NULL)),
  CONSTRAINT fk_invitations_person FOREIGN KEY (society_id, person_id) REFERENCES society_persons (society_id, person_id),
  CONSTRAINT fk_invitations_flat FOREIGN KEY (society_id, flat_id) REFERENCES flats (society_id, id),
  CONSTRAINT fk_invitations_role FOREIGN KEY (society_id, role_id) REFERENCES roles (society_id, id),
  CONSTRAINT fk_invitations_creator FOREIGN KEY (created_by_user_id) REFERENCES users (id),
  CONSTRAINT fk_invitations_acceptor FOREIGN KEY (accepted_by_user_id) REFERENCES users (id),
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (id),
  UNIQUE KEY uq_invitations_scope (society_id, id),
  CONSTRAINT fk_invitations_society FOREIGN KEY (society_id) REFERENCES societies (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_ci;

-- statement-breakpoint

CREATE TABLE registration_requests (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  society_id BIGINT UNSIGNED NOT NULL,
  user_id BIGINT UNSIGNED NOT NULL,
  requested_flat_id BIGINT UNSIGNED NOT NULL,
  requested_occupancy_type VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT 'AUTHORIZED_OCCUPANT',
  CHECK (requested_occupancy_type IN ('OWNER', 'TENANT', 'FAMILY_MEMBER', 'AUTHORIZED_OCCUPANT')),
  status VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT 'PENDING',
  CHECK (status IN ('PENDING', 'APPROVED', 'REJECTED', 'CANCELLED')),
  reviewed_by_membership_id BIGINT UNSIGNED NULL,
  reviewed_at DATETIME(6) NULL,
  decision_note VARCHAR(500) NULL,
  pending_user_id BIGINT UNSIGNED GENERATED ALWAYS AS (CASE WHEN status = 'PENDING' THEN user_id ELSE NULL END) STORED,
  UNIQUE KEY uq_registration_requests_pending (society_id, pending_user_id),
  KEY ix_registration_requests_queue (society_id, status, created_at),
  CHECK ((status IN ('APPROVED', 'REJECTED') AND reviewed_at IS NOT NULL AND reviewed_by_membership_id IS NOT NULL) OR (status IN ('PENDING', 'CANCELLED') AND reviewed_at IS NULL AND reviewed_by_membership_id IS NULL)),
  CONSTRAINT fk_registration_requests_user FOREIGN KEY (user_id) REFERENCES users (id),
  CONSTRAINT fk_registration_requests_flat FOREIGN KEY (society_id, requested_flat_id) REFERENCES flats (society_id, id),
  CONSTRAINT fk_registration_requests_reviewer FOREIGN KEY (society_id, reviewed_by_membership_id) REFERENCES society_memberships (society_id, id),
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (id),
  UNIQUE KEY uq_registration_requests_scope (society_id, id),
  CONSTRAINT fk_registration_requests_society FOREIGN KEY (society_id) REFERENCES societies (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_ci;

