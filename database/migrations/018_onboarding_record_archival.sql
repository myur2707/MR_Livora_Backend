-- Immutable soft-delete markers preserve source rows and their history.
CREATE TABLE onboarding_archived_records (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  society_id BIGINT UNSIGNED NOT NULL,
  entity_type ENUM('occupancy') NOT NULL,
  entity_id BIGINT UNSIGNED NOT NULL,
  archived_at DATETIME(6) NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_onboarding_archive_entity (society_id,entity_type,entity_id),
  CONSTRAINT fk_onboarding_archive_society FOREIGN KEY (society_id) REFERENCES societies (id),
  CONSTRAINT fk_onboarding_archive_occupancy FOREIGN KEY (society_id,entity_id) REFERENCES flat_occupancies (society_id,id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_ci;

-- statement-breakpoint

CREATE TRIGGER onboarding_archive_no_update BEFORE UPDATE ON onboarding_archived_records FOR EACH ROW
 SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='Onboarding archive records are immutable';

-- statement-breakpoint

CREATE TRIGGER onboarding_archive_no_delete BEFORE DELETE ON onboarding_archived_records FOR EACH ROW
 SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='Onboarding archive records are retained';
