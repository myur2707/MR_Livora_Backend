-- Additive baseline. Default foreign-key actions are RESTRICT / NO ACTION.
-- Execute through the migration runner; each boundary separates a whole statement.

CREATE TABLE notices (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  society_id BIGINT UNSIGNED NOT NULL,
  title VARCHAR(200) NOT NULL,
  body TEXT NOT NULL,
  status VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT 'DRAFT',
  CHECK (status IN ('DRAFT', 'PUBLISHED', 'ARCHIVED')),
  published_at DATETIME(6) NULL,
  created_by_membership_id BIGINT UNSIGNED NOT NULL,
  KEY ix_notices_feed (society_id, status, published_at, id),
  CHECK (status <> 'PUBLISHED' OR published_at IS NOT NULL),
  CONSTRAINT fk_notices_author FOREIGN KEY (society_id, created_by_membership_id) REFERENCES society_memberships (society_id, id),
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (id),
  UNIQUE KEY uq_notices_scope (society_id, id),
  CONSTRAINT fk_notices_society FOREIGN KEY (society_id) REFERENCES societies (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_ci;

-- statement-breakpoint

CREATE TABLE complaints (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  society_id BIGINT UNSIGNED NOT NULL,
  submitted_by_membership_id BIGINT UNSIGNED NOT NULL,
  flat_id BIGINT UNSIGNED NOT NULL,
  title VARCHAR(200) NOT NULL,
  description TEXT NOT NULL,
  status VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT 'OPEN',
  CHECK (status IN ('OPEN', 'IN_PROGRESS', 'RESOLVED', 'CLOSED')),
  resolved_at DATETIME(6) NULL,
  archived_at DATETIME(6) NULL,
  KEY ix_complaints_queue (society_id, status, created_at, id),
  KEY ix_complaints_submitter (society_id, submitted_by_membership_id, created_at),
  CONSTRAINT fk_complaints_author FOREIGN KEY (society_id, submitted_by_membership_id) REFERENCES society_memberships (society_id, id),
  CONSTRAINT fk_complaints_flat FOREIGN KEY (society_id, flat_id) REFERENCES flats (society_id, id),
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (id),
  UNIQUE KEY uq_complaints_scope (society_id, id),
  CONSTRAINT fk_complaints_society FOREIGN KEY (society_id) REFERENCES societies (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_ci;

-- statement-breakpoint

CREATE TABLE audit_logs (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  society_id BIGINT UNSIGNED NOT NULL,
  actor_user_id BIGINT UNSIGNED NULL,
  action VARCHAR(100) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  entity_type VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  entity_id BIGINT UNSIGNED NULL,
  request_id VARCHAR(80) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  safe_metadata JSON NULL,
  KEY ix_audit_logs_timeline (society_id, created_at, id),
  KEY ix_audit_logs_entity (society_id, entity_type, entity_id, created_at),
  CONSTRAINT fk_audit_logs_actor FOREIGN KEY (actor_user_id) REFERENCES users (id),
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (id),
  UNIQUE KEY uq_audit_logs_scope (society_id, id),
  CONSTRAINT fk_audit_logs_society FOREIGN KEY (society_id) REFERENCES societies (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_ci;

