CREATE TABLE society_contacts (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  society_id BIGINT UNSIGNED NOT NULL,
  contact_phone VARCHAR(32) NULL,
  contact_email VARCHAR(254) NULL,
  updated_by_membership_id BIGINT UNSIGNED NOT NULL,
  updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  PRIMARY KEY (id),
  UNIQUE KEY uq_society_contacts_society (society_id),
  UNIQUE KEY uq_society_contacts_scope (society_id, id),
  CONSTRAINT fk_society_contacts_society FOREIGN KEY (society_id) REFERENCES societies (id),
  CONSTRAINT fk_society_contacts_member FOREIGN KEY (society_id, updated_by_membership_id) REFERENCES society_memberships (society_id, id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_ci;
