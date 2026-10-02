-- Additive identity infrastructure; baseline migrations remain immutable.
CREATE TABLE auth_sessions (
  token_hash BINARY(32) NOT NULL,
  user_id BIGINT UNSIGNED NULL,
  society_id BIGINT UNSIGNED NULL,
  created_at DATETIME(6) NOT NULL,
  idle_expires_at DATETIME(6) NOT NULL,
  absolute_expires_at DATETIME(6) NOT NULL,
  revoked_at DATETIME(6) NULL,
  PRIMARY KEY (token_hash),
  KEY ix_auth_sessions_user (user_id, revoked_at),
  KEY ix_auth_sessions_expiry (absolute_expires_at),
  CHECK (idle_expires_at > created_at AND idle_expires_at <= absolute_expires_at),
  CHECK (society_id IS NULL OR user_id IS NOT NULL),
  CONSTRAINT fk_auth_sessions_user FOREIGN KEY (user_id) REFERENCES users (id),
  CONSTRAINT fk_auth_sessions_society FOREIGN KEY (society_id) REFERENCES societies (id),
  CONSTRAINT fk_auth_sessions_membership FOREIGN KEY (society_id, user_id) REFERENCES society_memberships (society_id, user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
-- statement-breakpoint
CREATE TABLE password_reset_tokens (
  token_hash BINARY(32) NOT NULL,
  user_id BIGINT UNSIGNED NOT NULL,
  created_at DATETIME(6) NOT NULL,
  expires_at DATETIME(6) NOT NULL,
  consumed_at DATETIME(6) NULL,
  PRIMARY KEY (token_hash),
  KEY ix_password_reset_user (user_id, consumed_at),
  KEY ix_password_reset_expiry (expires_at),
  CHECK (expires_at > created_at),
  CHECK (consumed_at IS NULL OR consumed_at >= created_at),
  CONSTRAINT fk_password_reset_user FOREIGN KEY (user_id) REFERENCES users (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
-- statement-breakpoint
CREATE TABLE platform_user_roles (
  user_id BIGINT UNSIGNED NOT NULL,
  role_code VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  granted_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (user_id, role_code),
  CHECK (role_code = 'PLATFORM_ADMIN'),
  CONSTRAINT fk_platform_role_user FOREIGN KEY (user_id) REFERENCES users (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
-- statement-breakpoint
CREATE TABLE auth_rate_limits (
  bucket_hash BINARY(32) NOT NULL,
  attempts INT UNSIGNED NOT NULL,
  expires_at DATETIME(6) NOT NULL,
  PRIMARY KEY (bucket_hash),
  KEY ix_auth_rate_limit_expiry (expires_at),
  CHECK (attempts > 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
-- statement-breakpoint
CREATE TABLE auth_events (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id BIGINT UNSIGNED NULL,
  action VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  request_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  ip_hash BINARY(32) NOT NULL,
  created_at DATETIME(6) NOT NULL,
  PRIMARY KEY (id),
  KEY ix_auth_events_user_time (user_id, created_at),
  KEY ix_auth_events_time (created_at),
  CHECK (action IN ('login.succeeded', 'login.failed', 'logout', 'password.reset.requested', 'password.reset.completed', 'context.selected', 'mail.delivery.failed')),
  CONSTRAINT fk_auth_events_user FOREIGN KEY (user_id) REFERENCES users (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
-- statement-breakpoint
CREATE TRIGGER auth_events_no_update BEFORE UPDATE ON auth_events
FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Security audit records are immutable';
-- statement-breakpoint
CREATE TRIGGER auth_events_no_delete BEFORE DELETE ON auth_events
FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Security audit records are immutable';
