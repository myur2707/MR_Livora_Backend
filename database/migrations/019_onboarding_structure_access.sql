-- Platform approval required before a committee administrator can add homes during setup.
CREATE TABLE society_onboarding_structure_access (
  society_id BIGINT UNSIGNED NOT NULL,
  allowed TINYINT(1) NOT NULL DEFAULT 0,
  granted_by_user_id BIGINT UNSIGNED NULL,
  granted_at DATETIME(6) NULL,
  revoked_by_user_id BIGINT UNSIGNED NULL,
  revoked_at DATETIME(6) NULL,
  updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (society_id),
  CONSTRAINT fk_structure_access_society FOREIGN KEY (society_id) REFERENCES societies (id),
  CONSTRAINT fk_structure_access_granter FOREIGN KEY (granted_by_user_id) REFERENCES users (id),
  CONSTRAINT fk_structure_access_revoker FOREIGN KEY (revoked_by_user_id) REFERENCES users (id),
  CHECK (allowed IN (0,1)),
  CHECK ((allowed=1 AND granted_by_user_id IS NOT NULL AND granted_at IS NOT NULL AND revoked_by_user_id IS NULL AND revoked_at IS NULL) OR (allowed=0 AND granted_by_user_id IS NULL AND granted_at IS NULL))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_ci;
