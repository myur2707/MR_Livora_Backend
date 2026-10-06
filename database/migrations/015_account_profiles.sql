CREATE TABLE account_profiles (
  user_id BIGINT UNSIGNED NOT NULL,
  display_name VARCHAR(160) NOT NULL,
  contact_phone VARCHAR(32) NULL,
  updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  PRIMARY KEY (user_id),
  CONSTRAINT fk_account_profiles_user FOREIGN KEY (user_id) REFERENCES users (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_ci;

-- statement-breakpoint

CREATE TABLE account_profile_events (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id BIGINT UNSIGNED NOT NULL,
  action VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  request_id VARCHAR(80) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  ip_hash BINARY(32) NOT NULL,
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (id),
  KEY ix_account_profile_event_user (user_id, created_at, id),
  CHECK (action = 'PROFILE_UPDATED'),
  CONSTRAINT fk_account_profile_event_user FOREIGN KEY (user_id) REFERENCES users (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_ci;

-- statement-breakpoint

CREATE TRIGGER account_profile_event_no_update BEFORE UPDATE ON account_profile_events FOR EACH ROW
 SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='Account profile audit is immutable';

-- statement-breakpoint

CREATE TRIGGER account_profile_event_no_delete BEFORE DELETE ON account_profile_events FOR EACH ROW
 SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='Account profile audit is retained';
