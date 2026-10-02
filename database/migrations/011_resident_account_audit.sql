-- Global email verification happens before any society access exists.
-- Existing auth_events has an immutable, narrower action vocabulary.
CREATE TABLE resident_account_events (
 id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
 user_id BIGINT UNSIGNED NOT NULL,
 action VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
 request_id VARCHAR(80) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
 ip_hash BINARY(32) NOT NULL,
 created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
 PRIMARY KEY(id),
 KEY ix_resident_account_event_user(user_id,created_at,id),
 CHECK(action='ACCOUNT_VERIFIED'),
 CONSTRAINT fk_resident_account_event_user FOREIGN KEY(user_id) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_ci;
-- statement-breakpoint
CREATE TRIGGER resident_account_event_no_update BEFORE UPDATE ON resident_account_events FOR EACH ROW
 SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='Account verification audit is immutable';
-- statement-breakpoint
CREATE TRIGGER resident_account_event_no_delete BEFORE DELETE ON resident_account_events FOR EACH ROW
 SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='Account verification audit is retained';
