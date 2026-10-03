-- Additive community workflows. Existing complaint status is retained as legacy data;
-- complaint_workflows is authoritative when present. No data backfill or destructive DDL.
CREATE TABLE notice_details (
 id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
 society_id BIGINT UNSIGNED NOT NULL,
 notice_id BIGINT UNSIGNED NOT NULL,
 revision INT UNSIGNED NOT NULL DEFAULT 1 CHECK(revision>0),
 updated_by_membership_id BIGINT UNSIGNED NOT NULL,
 updated_at DATETIME(6) NOT NULL,
 PRIMARY KEY(id), UNIQUE KEY uq_notice_details_scope(society_id,id),
 UNIQUE KEY uq_notice_details_notice(society_id,notice_id),
 FOREIGN KEY(society_id) REFERENCES societies(id),
 FOREIGN KEY(society_id,notice_id) REFERENCES notices(society_id,id),
 FOREIGN KEY(society_id,updated_by_membership_id) REFERENCES society_memberships(society_id,id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_ci;

-- statement-breakpoint

CREATE TABLE complaint_workflows (
 id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
 society_id BIGINT UNSIGNED NOT NULL,
 complaint_id BIGINT UNSIGNED NOT NULL,
 category VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL CHECK(category IN ('MAINTENANCE','PLUMBING','ELECTRICAL','SECURITY','COMMON_AREA','OTHER')),
 status VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL CHECK(status IN ('NEW','ASSIGNED','IN_PROGRESS','RESOLVED','CLOSED')),
 assigned_to_membership_id BIGINT UNSIGNED NULL,
 revision INT UNSIGNED NOT NULL DEFAULT 1 CHECK(revision>0),
 resolved_at DATETIME(6) NULL,
 updated_at DATETIME(6) NOT NULL,
 CHECK(status<>'NEW' OR assigned_to_membership_id IS NULL),
 CHECK(status NOT IN ('ASSIGNED','IN_PROGRESS') OR assigned_to_membership_id IS NOT NULL),
 PRIMARY KEY(id), UNIQUE KEY uq_complaint_workflows_scope(society_id,id),
 UNIQUE KEY uq_complaint_workflows_complaint(society_id,complaint_id),
 KEY ix_complaint_workflows_queue(society_id,status,updated_at,id),
 KEY ix_complaint_workflows_assignee(society_id,assigned_to_membership_id,status,id),
 FOREIGN KEY(society_id) REFERENCES societies(id),
 FOREIGN KEY(society_id,complaint_id) REFERENCES complaints(society_id,id),
 FOREIGN KEY(society_id,assigned_to_membership_id) REFERENCES society_memberships(society_id,id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_ci;

-- statement-breakpoint

CREATE TABLE complaint_status_history (
 id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
 society_id BIGINT UNSIGNED NOT NULL,
 complaint_id BIGINT UNSIGNED NOT NULL,
 from_status VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NULL CHECK(from_status IS NULL OR from_status IN ('NEW','ASSIGNED','IN_PROGRESS','RESOLVED','CLOSED')),
 to_status VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL CHECK(to_status IN ('NEW','ASSIGNED','IN_PROGRESS','RESOLVED','CLOSED')),
 assigned_to_membership_id BIGINT UNSIGNED NULL,
 actor_membership_id BIGINT UNSIGNED NOT NULL,
 note VARCHAR(1000) NOT NULL,
 revision INT UNSIGNED NOT NULL CHECK(revision>0),
 created_at DATETIME(6) NOT NULL,
 PRIMARY KEY(id), UNIQUE KEY uq_complaint_status_history_scope(society_id,id),
 UNIQUE KEY uq_complaint_status_history_revision(society_id,complaint_id,revision),
 KEY ix_complaint_status_history_timeline(society_id,complaint_id,created_at,id),
 FOREIGN KEY(society_id) REFERENCES societies(id),
 FOREIGN KEY(society_id,complaint_id) REFERENCES complaints(society_id,id),
 FOREIGN KEY(society_id,assigned_to_membership_id) REFERENCES society_memberships(society_id,id),
 FOREIGN KEY(society_id,actor_membership_id) REFERENCES society_memberships(society_id,id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_ci;

-- statement-breakpoint

CREATE TRIGGER complaint_history_update BEFORE UPDATE ON complaint_status_history FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='Complaint history is immutable';

-- statement-breakpoint

CREATE TRIGGER complaint_history_delete BEFORE DELETE ON complaint_status_history FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='Complaint history is immutable';

-- statement-breakpoint

CREATE TRIGGER complaint_workflow_delete BEFORE DELETE ON complaint_workflows FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='Complaint workflow must be retained';
