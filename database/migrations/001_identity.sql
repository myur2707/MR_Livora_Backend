-- Additive baseline. Default foreign-key actions are RESTRICT / NO ACTION.
-- Execute through the migration runner; each boundary separates a whole statement.

CREATE TABLE societies (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  code VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  name VARCHAR(200) NOT NULL,
  timezone VARCHAR(64) NOT NULL DEFAULT 'Asia/Kolkata',
  status VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT 'DRAFT',
  CHECK (status IN ('DRAFT', 'SETUP_IN_PROGRESS', 'PENDING_VERIFICATION', 'ACTIVE', 'SUSPENDED', 'DEACTIVATED')),
  archived_at DATETIME(6) NULL,
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  PRIMARY KEY (id),
  UNIQUE KEY uq_societies_code (code)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_ci;

-- statement-breakpoint

CREATE TABLE persons (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_ci;

-- statement-breakpoint

CREATE TABLE users (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  person_id BIGINT UNSIGNED NOT NULL,
  email_normalized VARCHAR(254) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  password_hash VARCHAR(255) CHARACTER SET ascii COLLATE ascii_bin NULL,
  status VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT 'PENDING',
  CHECK (status IN ('PENDING', 'ACTIVE', 'DISABLED')),
  email_verified_at DATETIME(6) NULL,
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  PRIMARY KEY (id),
  UNIQUE KEY uq_users_person (person_id),
  UNIQUE KEY uq_users_email (email_normalized),
  CHECK (email_normalized = LOWER(TRIM(email_normalized))),
  CONSTRAINT fk_users_person FOREIGN KEY (person_id) REFERENCES persons (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_ci;

-- statement-breakpoint

CREATE TABLE society_persons (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  society_id BIGINT UNSIGNED NOT NULL,
  person_id BIGINT UNSIGNED NOT NULL,
  display_name VARCHAR(160) NOT NULL,
  contact_email VARCHAR(254) NULL,
  contact_phone VARCHAR(32) NULL,
  archived_at DATETIME(6) NULL,
  UNIQUE KEY uq_society_persons_person (society_id, person_id),
  KEY ix_society_persons_active (society_id, archived_at, id),
  CONSTRAINT fk_society_persons_person FOREIGN KEY (person_id) REFERENCES persons (id),
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (id),
  UNIQUE KEY uq_society_persons_scope (society_id, id),
  CONSTRAINT fk_society_persons_society FOREIGN KEY (society_id) REFERENCES societies (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_ci;

-- statement-breakpoint

CREATE TABLE society_memberships (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  society_id BIGINT UNSIGNED NOT NULL,
  user_id BIGINT UNSIGNED NOT NULL,
  status VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT 'PENDING',
  CHECK (status IN ('PENDING', 'ACTIVE', 'SUSPENDED', 'DEACTIVATED')),
  joined_at DATETIME(6) NULL,
  ended_at DATETIME(6) NULL,
  UNIQUE KEY uq_society_memberships_user (society_id, user_id),
  KEY ix_society_memberships_user_status (user_id, status, society_id),
  CHECK (ended_at IS NULL OR (joined_at IS NOT NULL AND ended_at >= joined_at)),
  CONSTRAINT fk_society_memberships_user FOREIGN KEY (user_id) REFERENCES users (id),
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (id),
  UNIQUE KEY uq_society_memberships_scope (society_id, id),
  CONSTRAINT fk_society_memberships_society FOREIGN KEY (society_id) REFERENCES societies (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_ci;

-- statement-breakpoint

CREATE TABLE roles (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  society_id BIGINT UNSIGNED NOT NULL,
  code VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  name VARCHAR(100) NOT NULL,
  archived_at DATETIME(6) NULL,
  UNIQUE KEY uq_roles_code (society_id, code),
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (id),
  UNIQUE KEY uq_roles_scope (society_id, id),
  CONSTRAINT fk_roles_society FOREIGN KEY (society_id) REFERENCES societies (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_ci;

-- statement-breakpoint

CREATE TABLE permissions (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  code VARCHAR(100) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  description VARCHAR(255) NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_permissions_code (code)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_ci;

-- statement-breakpoint

CREATE TABLE role_permissions (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  society_id BIGINT UNSIGNED NOT NULL,
  role_id BIGINT UNSIGNED NOT NULL,
  permission_id BIGINT UNSIGNED NOT NULL,
  UNIQUE KEY uq_role_permissions_grant (society_id, role_id, permission_id),
  CONSTRAINT fk_role_permissions_role FOREIGN KEY (society_id, role_id) REFERENCES roles (society_id, id),
  CONSTRAINT fk_role_permissions_permission FOREIGN KEY (permission_id) REFERENCES permissions (id),
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (id),
  UNIQUE KEY uq_role_permissions_scope (society_id, id),
  CONSTRAINT fk_role_permissions_society FOREIGN KEY (society_id) REFERENCES societies (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_ci;

-- statement-breakpoint

CREATE TABLE membership_roles (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  society_id BIGINT UNSIGNED NOT NULL,
  membership_id BIGINT UNSIGNED NOT NULL,
  role_id BIGINT UNSIGNED NOT NULL,
  UNIQUE KEY uq_membership_roles_grant (society_id, membership_id, role_id),
  CONSTRAINT fk_membership_roles_membership FOREIGN KEY (society_id, membership_id) REFERENCES society_memberships (society_id, id),
  CONSTRAINT fk_membership_roles_role FOREIGN KEY (society_id, role_id) REFERENCES roles (society_id, id),
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (id),
  UNIQUE KEY uq_membership_roles_scope (society_id, id),
  CONSTRAINT fk_membership_roles_society FOREIGN KEY (society_id) REFERENCES societies (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_ci;

