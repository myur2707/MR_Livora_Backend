-- What a setup change did (for example which wings and flat numbers were added or skipped).
-- Structure facts only: no personal, contact or financial values. One row per event, append-only.
CREATE TABLE society_onboarding_event_details (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  society_id BIGINT UNSIGNED NOT NULL,
  event_id BIGINT UNSIGNED NOT NULL,
  details JSON NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_onboarding_event_details_scope (society_id, id),
  UNIQUE KEY uq_onboarding_event_details_event (society_id, event_id),
  CONSTRAINT fk_onboarding_event_details_society FOREIGN KEY (society_id) REFERENCES societies (id),
  CONSTRAINT fk_onboarding_event_details_event FOREIGN KEY (society_id, event_id) REFERENCES society_onboarding_events (society_id, id),
  CHECK (JSON_TYPE(details) = 'OBJECT'),
  CHECK (JSON_STORAGE_SIZE(details) <= 32768)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_ci;

-- statement-breakpoint

CREATE TRIGGER onboarding_event_details_no_update BEFORE UPDATE ON society_onboarding_event_details FOR EACH ROW
 SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='Onboarding event details are immutable';

-- statement-breakpoint

CREATE TRIGGER onboarding_event_details_no_delete BEFORE DELETE ON society_onboarding_event_details FOR EACH ROW
 SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='Onboarding event details are retained';
