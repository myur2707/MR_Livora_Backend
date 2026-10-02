-- Additive onboarding state. Existing societies are not silently baselined.
CREATE TABLE society_onboarding (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  society_id BIGINT UNSIGNED NOT NULL,
  revision BIGINT UNSIGNED NOT NULL DEFAULT 1,
  residents_confirmed BOOLEAN NOT NULL DEFAULT FALSE,
  maintenance_confirmed BOOLEAN NOT NULL DEFAULT FALSE,
  reviewed_revision BIGINT UNSIGNED NULL,
  reviewed_by_membership_id BIGINT UNSIGNED NULL,
  reviewed_at DATETIME(6) NULL,
  verified_by_membership_id BIGINT UNSIGNED NULL,
  verified_at DATETIME(6) NULL,
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (id),
  UNIQUE KEY uq_onboarding_society (society_id),
  UNIQUE KEY uq_onboarding_scope (society_id, id),
  CHECK (revision > 0 AND residents_confirmed IN (0,1) AND maintenance_confirmed IN (0,1)),
  CHECK ((reviewed_revision IS NULL AND reviewed_by_membership_id IS NULL AND reviewed_at IS NULL)
    OR (reviewed_revision IS NOT NULL AND reviewed_revision <= revision AND reviewed_by_membership_id IS NOT NULL AND reviewed_at IS NOT NULL)),
  CHECK ((verified_by_membership_id IS NULL AND verified_at IS NULL)
    OR (verified_by_membership_id IS NOT NULL AND verified_at IS NOT NULL AND reviewed_revision IS NOT NULL AND reviewed_revision = revision)),
  CONSTRAINT fk_onboarding_society FOREIGN KEY (society_id) REFERENCES societies(id),
  CONSTRAINT fk_onboarding_reviewer FOREIGN KEY (society_id, reviewed_by_membership_id) REFERENCES society_memberships(society_id,id),
  CONSTRAINT fk_onboarding_verifier FOREIGN KEY (society_id, verified_by_membership_id) REFERENCES society_memberships(society_id,id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_ci;
-- statement-breakpoint
-- Initial admin invitations have no Person/User until recipient proof. Resident invitations retain their existing contract.
CREATE TABLE society_setup_invitations (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  society_id BIGINT UNSIGNED NOT NULL,
  email_normalized VARCHAR(254) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  display_name VARCHAR(160) NOT NULL,
  token_hash BINARY(32) NOT NULL,
  status VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT 'PENDING',
  delivery_status VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT 'QUEUED',
  expires_at DATETIME(6) NOT NULL,
  accepted_at DATETIME(6) NULL,
  accepted_by_user_id BIGINT UNSIGNED NULL,
  created_by_user_id BIGINT UNSIGNED NOT NULL,
  pending_marker TINYINT GENERATED ALWAYS AS (CASE WHEN status = 'PENDING' THEN 1 ELSE NULL END) STORED,
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (id),
  UNIQUE KEY uq_setup_invitation_scope (society_id,id),
  UNIQUE KEY uq_setup_invitation_hash (token_hash),
  UNIQUE KEY uq_setup_invitation_pending (society_id,pending_marker),
  KEY ix_setup_invitation_expiry (society_id,status,expires_at),
  CHECK (status IN ('PENDING','ACCEPTED','EXPIRED','REVOKED')),
  CHECK (delivery_status IN ('QUEUED','SENT','FAILED')),
  CHECK (email_normalized = LOWER(TRIM(email_normalized)) AND expires_at > created_at),
  CHECK ((status = 'ACCEPTED' AND accepted_at IS NOT NULL AND accepted_by_user_id IS NOT NULL)
    OR (status <> 'ACCEPTED' AND accepted_at IS NULL AND accepted_by_user_id IS NULL)),
  CONSTRAINT fk_setup_invitation_society FOREIGN KEY(society_id) REFERENCES societies(id),
  CONSTRAINT fk_setup_invitation_creator FOREIGN KEY(created_by_user_id) REFERENCES users(id),
  CONSTRAINT fk_setup_invitation_acceptor FOREIGN KEY(accepted_by_user_id) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_ci;
-- statement-breakpoint
-- Public setup audit projection, separate from private/general tenant audit metadata.
CREATE TABLE society_onboarding_events (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  society_id BIGINT UNSIGNED NOT NULL,
  actor_user_id BIGINT UNSIGNED NOT NULL,
  action VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  from_status VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NULL,
  to_status VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  revision BIGINT UNSIGNED NOT NULL,
  request_id VARCHAR(80) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY(id),
  UNIQUE KEY uq_onboarding_event_scope(society_id,id),
  KEY ix_onboarding_event_timeline(society_id,id),
  CHECK (revision > 0),
  CHECK (action IN ('society.created','society.status_changed','committee.invited','committee.accepted','building.created','resident.created','residents.confirmed','maintenance.created','maintenance.confirmed','setup.reviewed','society.activated')),
  CHECK (from_status IS NULL OR from_status IN ('DRAFT','SETUP_IN_PROGRESS','PENDING_VERIFICATION','ACTIVE','SUSPENDED','DEACTIVATED')),
  CHECK (to_status IN ('DRAFT','SETUP_IN_PROGRESS','PENDING_VERIFICATION','ACTIVE','SUSPENDED','DEACTIVATED')),
  CONSTRAINT fk_onboarding_event_society FOREIGN KEY(society_id) REFERENCES societies(id),
  CONSTRAINT fk_onboarding_event_actor FOREIGN KEY(actor_user_id) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_ci;
-- statement-breakpoint
CREATE TRIGGER onboarding_events_no_update BEFORE UPDATE ON society_onboarding_events FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Onboarding events are append only';
END;
-- statement-breakpoint
CREATE TRIGGER onboarding_events_no_delete BEFORE DELETE ON society_onboarding_events FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Onboarding events are append only';
END;
-- statement-breakpoint
CREATE TRIGGER onboarding_verification_immutable BEFORE UPDATE ON society_onboarding FOR EACH ROW
BEGIN
  IF OLD.verified_at IS NOT NULL AND (
    NOT (NEW.verified_at <=> OLD.verified_at) OR NOT (NEW.verified_by_membership_id <=> OLD.verified_by_membership_id)
    OR NEW.revision <> OLD.revision OR NOT (NEW.reviewed_revision <=> OLD.reviewed_revision)
    OR NOT (NEW.reviewed_by_membership_id <=> OLD.reviewed_by_membership_id) OR NOT (NEW.reviewed_at <=> OLD.reviewed_at)
    OR NEW.residents_confirmed <> OLD.residents_confirmed OR NEW.maintenance_confirmed <> OLD.maintenance_confirmed
  ) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Completed onboarding verification is immutable';
  END IF;
END;
-- statement-breakpoint
CREATE TRIGGER onboarding_no_delete BEFORE DELETE ON society_onboarding FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Archive society instead of deleting onboarding';
END;
-- statement-breakpoint
CREATE TRIGGER managed_society_lifecycle BEFORE UPDATE ON societies FOR EACH ROW
BEGIN
  IF OLD.status <> NEW.status AND EXISTS (SELECT 1 FROM society_onboarding WHERE society_id = OLD.id) THEN
    IF NOT (
      (OLD.status = 'DRAFT' AND NEW.status IN ('SETUP_IN_PROGRESS','DEACTIVATED'))
      OR (OLD.status = 'SETUP_IN_PROGRESS' AND NEW.status IN ('PENDING_VERIFICATION','DEACTIVATED'))
      OR (OLD.status = 'PENDING_VERIFICATION' AND NEW.status IN ('SETUP_IN_PROGRESS','ACTIVE','DEACTIVATED'))
      OR (OLD.status = 'ACTIVE' AND NEW.status IN ('SUSPENDED','DEACTIVATED'))
      OR (OLD.status = 'SUSPENDED' AND NEW.status IN ('ACTIVE','DEACTIVATED'))
    ) THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Invalid managed society lifecycle transition';
    END IF;
    IF NEW.status = 'ACTIVE' AND NOT EXISTS (
      SELECT 1 FROM society_onboarding o
      JOIN society_memberships m ON m.society_id=o.society_id AND m.id=o.verified_by_membership_id AND m.status='ACTIVE' AND m.ended_at IS NULL
      JOIN users u ON u.id=m.user_id AND u.status='ACTIVE'
      WHERE o.society_id=OLD.id AND o.verified_at IS NOT NULL AND o.reviewed_revision=o.revision
        AND o.residents_confirmed=1 AND o.maintenance_confirmed=1
        AND EXISTS (SELECT 1 FROM flats f WHERE f.society_id=OLD.id AND f.archived_at IS NULL)
        AND EXISTS (SELECT 1 FROM maintenance_charge_configurations c WHERE c.society_id=OLD.id)
    ) THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Managed society requires completed committee verification';
    END IF;
  END IF;
END;
