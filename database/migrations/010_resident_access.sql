-- Additive Step 6. Preserve all identity, occupancy and financial history.
-- A verified tenant identity can differ from a login's original global Person.
CREATE TABLE membership_person_links (
 id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
 society_id BIGINT UNSIGNED NOT NULL,
 membership_id BIGINT UNSIGNED NOT NULL,
 person_id BIGINT UNSIGNED NOT NULL,
 created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
 PRIMARY KEY(id),
 UNIQUE KEY uq_member_person_scope(society_id,id),
 UNIQUE KEY uq_member_person_membership(society_id,membership_id),
 UNIQUE KEY uq_member_person_identity(society_id,person_id),
 CONSTRAINT fk_member_person_society FOREIGN KEY(society_id) REFERENCES societies(id),
 CONSTRAINT fk_member_person_membership FOREIGN KEY(society_id,membership_id) REFERENCES society_memberships(society_id,id),
 CONSTRAINT fk_member_person_profile FOREIGN KEY(society_id,person_id) REFERENCES society_persons(society_id,person_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_ci;
-- statement-breakpoint
CREATE TABLE resident_invitation_details (
 id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
 society_id BIGINT UNSIGNED NOT NULL,
 invitation_id BIGINT UNSIGNED NOT NULL,
 intended_action VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT 'RESIDENT_JOIN',
 delivery_status VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT 'QUEUED',
 accepted_membership_id BIGINT UNSIGNED NULL,
 created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
 PRIMARY KEY(id),
 UNIQUE KEY uq_resident_invitation_scope(society_id,id),
 UNIQUE KEY uq_resident_invitation_details(society_id,invitation_id),
 CHECK(intended_action='RESIDENT_JOIN'),
 CHECK(delivery_status IN('QUEUED','SENT','FAILED')),
 CONSTRAINT fk_resident_invitation_society FOREIGN KEY(society_id) REFERENCES societies(id),
 CONSTRAINT fk_resident_invitation_base FOREIGN KEY(society_id,invitation_id) REFERENCES invitations(society_id,id),
 CONSTRAINT fk_resident_invitation_member FOREIGN KEY(society_id,accepted_membership_id) REFERENCES society_memberships(society_id,id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_ci;
-- statement-breakpoint
CREATE TABLE registration_request_details (
 id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
 society_id BIGINT UNSIGNED NOT NULL,
 request_id BIGINT UNSIGNED NOT NULL,
 display_name VARCHAR(160) NOT NULL,
 contact_phone VARCHAR(32) NULL,
 applicant_note VARCHAR(500) NULL,
 resolved_person_id BIGINT UNSIGNED NULL,
 approved_membership_id BIGINT UNSIGNED NULL,
 approved_occupancy_id BIGINT UNSIGNED NULL,
 created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
 PRIMARY KEY(id),
 UNIQUE KEY uq_registration_details_scope(society_id,id),
 UNIQUE KEY uq_registration_details_request(society_id,request_id),
 CHECK((resolved_person_id IS NULL AND approved_membership_id IS NULL AND approved_occupancy_id IS NULL) OR (resolved_person_id IS NOT NULL AND approved_membership_id IS NOT NULL AND approved_occupancy_id IS NOT NULL)),
 CONSTRAINT fk_registration_details_society FOREIGN KEY(society_id) REFERENCES societies(id),
 CONSTRAINT fk_registration_details_request FOREIGN KEY(society_id,request_id) REFERENCES registration_requests(society_id,id),
 CONSTRAINT fk_registration_details_person FOREIGN KEY(society_id,resolved_person_id) REFERENCES society_persons(society_id,person_id),
 CONSTRAINT fk_registration_details_member FOREIGN KEY(society_id,approved_membership_id) REFERENCES society_memberships(society_id,id),
 CONSTRAINT fk_registration_details_occupancy FOREIGN KEY(society_id,approved_occupancy_id) REFERENCES flat_occupancies(society_id,id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_ci;
-- statement-breakpoint
CREATE TABLE resident_account_verifications (
 token_hash BINARY(32) NOT NULL,
 email_normalized VARCHAR(254) CHARACTER SET ascii COLLATE ascii_bin NULL,
 display_name VARCHAR(160) NULL,
 password_hash VARCHAR(255) CHARACTER SET ascii COLLATE ascii_bin NULL,
 expires_at DATETIME(6) NOT NULL,
 consumed_at DATETIME(6) NULL,
 created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
 PRIMARY KEY(token_hash),
 KEY ix_resident_account_email(email_normalized,expires_at),
 KEY ix_resident_account_expiry(expires_at),
 CHECK(expires_at>created_at),
 CHECK(email_normalized IS NULL OR email_normalized=LOWER(TRIM(email_normalized)))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_ci;
-- statement-breakpoint
CREATE TRIGGER member_person_no_update BEFORE UPDATE ON membership_person_links FOR EACH ROW
 SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='Verified membership identity is immutable';
-- statement-breakpoint
CREATE TRIGGER member_person_no_delete BEFORE DELETE ON membership_person_links FOR EACH ROW
 SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='Verified membership identity is retained';
-- statement-breakpoint
CREATE TRIGGER resident_invitation_transition BEFORE UPDATE ON invitations FOR EACH ROW
BEGIN
 IF NOT(NEW.society_id<=>OLD.society_id) OR NOT(NEW.person_id<=>OLD.person_id) OR NOT(NEW.flat_id<=>OLD.flat_id) OR NOT(NEW.role_id<=>OLD.role_id) OR NOT(NEW.email_normalized<=>OLD.email_normalized) OR NOT(NEW.token_hash<=>OLD.token_hash) OR NOT(NEW.expires_at<=>OLD.expires_at) OR NOT(NEW.created_by_user_id<=>OLD.created_by_user_id) OR NOT(NEW.created_at<=>OLD.created_at) OR OLD.status<>'PENDING' OR NEW.status NOT IN('ACCEPTED','EXPIRED','REVOKED') THEN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='Invitation identity and terminal state are immutable';
 END IF;
 IF NEW.status='ACCEPTED' AND NOT EXISTS(SELECT 1 FROM resident_invitation_details d JOIN society_memberships m ON m.society_id=d.society_id AND m.id=d.accepted_membership_id JOIN membership_person_links l ON l.society_id=m.society_id AND l.membership_id=m.id WHERE d.society_id=NEW.society_id AND d.invitation_id=NEW.id AND m.user_id=NEW.accepted_by_user_id AND l.person_id=NEW.person_id) THEN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='Invitation acceptance requires a verified membership';
 END IF;
END;
-- statement-breakpoint
CREATE TRIGGER resident_registration_transition BEFORE UPDATE ON registration_requests FOR EACH ROW
BEGIN
 IF NOT(NEW.society_id<=>OLD.society_id) OR NOT(NEW.user_id<=>OLD.user_id) OR NOT(NEW.requested_flat_id<=>OLD.requested_flat_id) OR NOT(NEW.requested_occupancy_type<=>OLD.requested_occupancy_type) OR NOT(NEW.created_at<=>OLD.created_at) OR OLD.status<>'PENDING' OR NEW.status NOT IN('APPROVED','REJECTED','CANCELLED') THEN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='Registration identity and terminal state are immutable';
 END IF;
 IF NEW.status='APPROVED' AND NOT EXISTS(SELECT 1 FROM registration_request_details d JOIN society_memberships m ON m.society_id=d.society_id AND m.id=d.approved_membership_id JOIN membership_person_links l ON l.society_id=m.society_id AND l.membership_id=m.id JOIN flat_occupancies o ON o.society_id=d.society_id AND o.id=d.approved_occupancy_id WHERE d.society_id=NEW.society_id AND d.request_id=NEW.id AND m.user_id=NEW.user_id AND l.person_id=d.resolved_person_id AND o.person_id=d.resolved_person_id) THEN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='Approval requires verified person membership and occupancy';
 END IF;
END;
-- statement-breakpoint
CREATE TRIGGER resident_registration_details_update BEFORE UPDATE ON registration_request_details FOR EACH ROW
BEGIN
 IF NOT(NEW.society_id<=>OLD.society_id) OR NOT(NEW.request_id<=>OLD.request_id) OR NOT(NEW.display_name<=>OLD.display_name) OR NOT(NEW.contact_phone<=>OLD.contact_phone) OR NOT(NEW.applicant_note<=>OLD.applicant_note) OR NOT(NEW.created_at<=>OLD.created_at) OR NOT EXISTS(SELECT 1 FROM registration_requests r WHERE r.society_id=OLD.society_id AND r.id=OLD.request_id AND r.status='PENDING') THEN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='Registration evidence and completed approval are immutable';
 END IF;
END;
