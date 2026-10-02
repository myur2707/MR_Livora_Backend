-- Explicit tenant resident references and bounded, private CSV staging. No existing data is changed.
CREATE TABLE society_person_references (
 id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
 society_id BIGINT UNSIGNED NOT NULL,
 person_id BIGINT UNSIGNED NOT NULL,
 reference_code VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
 created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
 PRIMARY KEY(id),
 UNIQUE KEY uq_person_reference_code(society_id,reference_code),
 UNIQUE KEY uq_person_reference_person(society_id,person_id),
 UNIQUE KEY uq_person_reference_scope(society_id,id),
 CHECK (reference_code=UPPER(TRIM(reference_code)) AND CHAR_LENGTH(reference_code) BETWEEN 3 AND 64),
 CONSTRAINT fk_person_reference_society FOREIGN KEY(society_id) REFERENCES societies(id),
 CONSTRAINT fk_person_reference_profile FOREIGN KEY(society_id,person_id) REFERENCES society_persons(society_id,person_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_ci;
-- statement-breakpoint
CREATE TABLE society_import_batches (
 id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
 society_id BIGINT UNSIGNED NOT NULL,
 created_by_membership_id BIGINT UNSIGNED NOT NULL,
 import_type VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
 status VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT 'REVIEW',
 source_hash BINARY(32) NOT NULL,
 validation_hash BINARY(32) NOT NULL,
 total_rows SMALLINT UNSIGNED NOT NULL,
 error_rows SMALLINT UNSIGNED NOT NULL,
 warning_rows SMALLINT UNSIGNED NOT NULL,
 expires_at DATETIME(6) NOT NULL,
 confirmed_at DATETIME(6) NULL,
 result_summary JSON NULL,
 created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
 PRIMARY KEY(id),
 UNIQUE KEY uq_import_batch_scope(society_id,id),
 KEY ix_import_batch_owner(society_id,created_by_membership_id,id),
 KEY ix_import_batch_expiry(status,expires_at),
 CHECK (import_type IN ('FLATS','RESIDENTS')),
 CHECK (status IN ('REVIEW','CONFIRMED','CANCELLED','EXPIRED')),
 CHECK (total_rows BETWEEN 1 AND 500 AND error_rows<=total_rows AND warning_rows<=total_rows),
 CHECK (expires_at>created_at),
 CHECK ((status='CONFIRMED' AND confirmed_at IS NOT NULL AND result_summary IS NOT NULL) OR (status<>'CONFIRMED' AND confirmed_at IS NULL AND result_summary IS NULL)),
 CONSTRAINT fk_import_batch_society FOREIGN KEY(society_id) REFERENCES societies(id),
 CONSTRAINT fk_import_batch_creator FOREIGN KEY(society_id,created_by_membership_id) REFERENCES society_memberships(society_id,id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_ci;
-- statement-breakpoint
CREATE TABLE society_import_rows (
 id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
 society_id BIGINT UNSIGNED NOT NULL,
 batch_id BIGINT UNSIGNED NOT NULL,
 csv_row_number SMALLINT UNSIGNED NOT NULL,
 line_number INT UNSIGNED NOT NULL,
 row_data JSON NULL,
 validation_errors JSON NULL,
 validation_warnings JSON NULL,
 PRIMARY KEY(id),
 UNIQUE KEY uq_import_csv_row_number(society_id,batch_id,csv_row_number),
 UNIQUE KEY uq_import_row_scope(society_id,id),
 CHECK (csv_row_number BETWEEN 2 AND 501 AND line_number>=csv_row_number),
 CONSTRAINT fk_import_row_society FOREIGN KEY(society_id) REFERENCES societies(id),
 CONSTRAINT fk_import_row_batch FOREIGN KEY(society_id,batch_id) REFERENCES society_import_batches(society_id,id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_ci;
-- statement-breakpoint
CREATE TRIGGER confirmed_import_immutable BEFORE UPDATE ON society_import_batches FOR EACH ROW
BEGIN
 IF OLD.status='CONFIRMED' THEN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='Completed import evidence is immutable';
 END IF;
END;
-- statement-breakpoint
CREATE TRIGGER import_batch_no_delete BEFORE DELETE ON society_import_batches FOR EACH ROW
BEGIN
 SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='Retain import evidence and minimize staged personal data';
END;
-- statement-breakpoint
CREATE TRIGGER occupancy_history_close_only BEFORE UPDATE ON flat_occupancies FOR EACH ROW
BEGIN
 IF OLD.ends_on IS NOT NULL OR NEW.society_id<>OLD.society_id OR NEW.flat_id<>OLD.flat_id
  OR NEW.person_id<>OLD.person_id OR NEW.occupancy_type<>OLD.occupancy_type OR NEW.starts_on<>OLD.starts_on
  OR NEW.ends_on IS NULL THEN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='Retain occupancy identity and closed history; only close open records';
 END IF;
END;
-- statement-breakpoint
CREATE TRIGGER occupancy_history_no_delete BEFORE DELETE ON flat_occupancies FOR EACH ROW
BEGIN
 SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='Retain occupancy history';
END;

