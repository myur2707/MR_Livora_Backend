-- Step 7 additive metadata and immutable billing history. Existing tables/data are retained.

CREATE TABLE maintenance_charge_type_details (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  society_id BIGINT UNSIGNED NOT NULL,
  charge_type_id BIGINT UNSIGNED NOT NULL,
  frequency VARCHAR(16) CHARACTER SET ascii NOT NULL CHECK (frequency IN ('MONTHLY','ONE_TIME')),
  created_by_membership_id BIGINT UNSIGNED NOT NULL,
  UNIQUE KEY uq_btype (society_id,charge_type_id),
  FOREIGN KEY (society_id,charge_type_id) REFERENCES maintenance_charge_types(society_id,id),
  FOREIGN KEY (society_id,created_by_membership_id) REFERENCES society_memberships(society_id,id),
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY(id),
  UNIQUE KEY uq_maintenance_charge_type_details_scope (society_id,id),
  FOREIGN KEY (society_id) REFERENCES societies(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_ci;

-- statement-breakpoint

CREATE TABLE maintenance_configuration_details (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  society_id BIGINT UNSIGNED NOT NULL,
  configuration_id BIGINT UNSIGNED NOT NULL,
  scope VARCHAR(16) CHARACTER SET ascii NOT NULL CHECK (scope IN ('SOCIETY','BUILDING','FLAT')),
  building_id BIGINT UNSIGNED NULL,
  eligibility VARCHAR(32) CHARACTER SET ascii NOT NULL CHECK (eligibility IN ('ALL_FLATS','OCCUPIED_ONLY')),
  enabled BOOLEAN NOT NULL CHECK (enabled IN (0,1)),
  created_by_membership_id BIGINT UNSIGNED NOT NULL,
  CHECK ((scope='BUILDING' AND building_id IS NOT NULL) OR (scope<>'BUILDING' AND building_id IS NULL)),
  UNIQUE KEY uq_bconfig (society_id,configuration_id),
  KEY ix_bconfig_building (society_id,building_id),
  FOREIGN KEY (society_id,configuration_id) REFERENCES maintenance_charge_configurations(society_id,id),
  FOREIGN KEY (society_id,building_id) REFERENCES buildings(society_id,id),
  FOREIGN KEY (society_id,created_by_membership_id) REFERENCES society_memberships(society_id,id),
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY(id),
  UNIQUE KEY uq_maintenance_configuration_details_scope (society_id,id),
  FOREIGN KEY (society_id) REFERENCES societies(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_ci;

-- statement-breakpoint

CREATE TABLE billing_period_details (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  society_id BIGINT UNSIGNED NOT NULL,
  period_id BIGINT UNSIGNED NOT NULL,
  kind VARCHAR(16) CHARACTER SET ascii NOT NULL CHECK (kind IN ('MONTHLY','ONE_TIME')),
  created_by_membership_id BIGINT UNSIGNED NOT NULL,
  UNIQUE KEY uq_bperiod (society_id,period_id),
  FOREIGN KEY (society_id,period_id) REFERENCES billing_periods(society_id,id),
  FOREIGN KEY (society_id,created_by_membership_id) REFERENCES society_memberships(society_id,id),
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY(id),
  UNIQUE KEY uq_billing_period_details_scope (society_id,id),
  FOREIGN KEY (society_id) REFERENCES societies(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_ci;

-- statement-breakpoint

CREATE TABLE billing_generation_runs (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  society_id BIGINT UNSIGNED NOT NULL,
  period_id BIGINT UNSIGNED NOT NULL,
  idempotency_key VARCHAR(80) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  request_hash BINARY(32) NOT NULL,
  preview_hash BINARY(32) NOT NULL,
  recorded_by_membership_id BIGINT UNSIGNED NOT NULL,
  status VARCHAR(16) CHARACTER SET ascii NOT NULL DEFAULT 'STARTED' CHECK (status IN ('STARTED','COMPLETED')),
  bill_count INT UNSIGNED NOT NULL DEFAULT 0 CHECK (bill_count <= 50),
  completed_at DATETIME(6) NULL,
  CHECK ((status='STARTED' AND completed_at IS NULL AND bill_count=0) OR (status='COMPLETED' AND completed_at IS NOT NULL AND bill_count>0)),
  UNIQUE KEY uq_brun_request (society_id,idempotency_key),
  KEY ix_brun_period (society_id,period_id),
  FOREIGN KEY (society_id,period_id) REFERENCES billing_periods(society_id,id),
  FOREIGN KEY (society_id,recorded_by_membership_id) REFERENCES society_memberships(society_id,id),
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY(id),
  UNIQUE KEY uq_billing_generation_runs_scope (society_id,id),
  FOREIGN KEY (society_id) REFERENCES societies(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_ci;

-- statement-breakpoint

CREATE TABLE billing_bill_details (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  society_id BIGINT UNSIGNED NOT NULL,
  bill_id BIGINT UNSIGNED NOT NULL,
  run_id BIGINT UNSIGNED NOT NULL,
  flat_id BIGINT UNSIGNED NOT NULL,
  building_code VARCHAR(64) NOT NULL,
  flat_number VARCHAR(32) NOT NULL,
  period_code VARCHAR(32) CHARACTER SET ascii NOT NULL,
  starts_on DATE NOT NULL,
  ends_on DATE NOT NULL,
  due_on DATE NOT NULL,
  previous_outstanding DECIMAL(12,2) NOT NULL CHECK (previous_outstanding>=0),
  UNIQUE KEY uq_bsnapshot (society_id,bill_id),
  KEY ix_bsnapshot_run (society_id,run_id),
  FOREIGN KEY (society_id,bill_id,flat_id) REFERENCES bills(society_id,id,flat_id),
  FOREIGN KEY (society_id,run_id) REFERENCES billing_generation_runs(society_id,id),
  FOREIGN KEY (society_id,flat_id) REFERENCES flats(society_id,id),
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY(id),
  UNIQUE KEY uq_billing_bill_details_scope (society_id,id),
  FOREIGN KEY (society_id) REFERENCES societies(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_ci;

-- statement-breakpoint

CREATE TABLE billing_discount_details (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  society_id BIGINT UNSIGNED NOT NULL,
  adjustment_id BIGINT UNSIGNED NOT NULL,
  kind VARCHAR(16) CHARACTER SET ascii NOT NULL CHECK (kind IN ('FIXED','PERCENT')),
  value DECIMAL(12,2) NOT NULL CHECK (value>0),
  gross_basis DECIMAL(12,2) NOT NULL CHECK (gross_basis>0),
  CHECK (kind<>'PERCENT' OR value<=100.00),
  UNIQUE KEY uq_bdiscount (society_id,adjustment_id),
  FOREIGN KEY (society_id,adjustment_id) REFERENCES bill_adjustments(society_id,id),
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY(id),
  UNIQUE KEY uq_billing_discount_details_scope (society_id,id),
  FOREIGN KEY (society_id) REFERENCES societies(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_ci;

-- statement-breakpoint

CREATE TABLE one_time_charge_applications (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  society_id BIGINT UNSIGNED NOT NULL,
  charge_type_id BIGINT UNSIGNED NOT NULL,
  configuration_id BIGINT UNSIGNED NOT NULL,
  flat_id BIGINT UNSIGNED NOT NULL,
  bill_id BIGINT UNSIGNED NOT NULL,
  UNIQUE KEY uq_one_time_flat (society_id,charge_type_id,flat_id),
  FOREIGN KEY (society_id,charge_type_id) REFERENCES maintenance_charge_types(society_id,id),
  FOREIGN KEY (society_id,configuration_id) REFERENCES maintenance_charge_configurations(society_id,id),
  FOREIGN KEY (society_id,flat_id) REFERENCES flats(society_id,id),
  FOREIGN KEY (society_id,bill_id,flat_id) REFERENCES bills(society_id,id,flat_id),
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY(id),
  UNIQUE KEY uq_one_time_charge_applications_scope (society_id,id),
  FOREIGN KEY (society_id) REFERENCES societies(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_ci;

-- statement-breakpoint

CREATE TRIGGER maintenance_charge_type_details_update BEFORE UPDATE ON maintenance_charge_type_details
FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='Billing metadata is immutable';

-- statement-breakpoint

CREATE TRIGGER maintenance_charge_type_details_delete BEFORE DELETE ON maintenance_charge_type_details
FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='Billing metadata is immutable';

-- statement-breakpoint

CREATE TRIGGER maintenance_configuration_details_update BEFORE UPDATE ON maintenance_configuration_details
FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='Billing metadata is immutable';

-- statement-breakpoint

CREATE TRIGGER maintenance_configuration_details_delete BEFORE DELETE ON maintenance_configuration_details
FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='Billing metadata is immutable';

-- statement-breakpoint

CREATE TRIGGER billing_period_details_update BEFORE UPDATE ON billing_period_details
FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='Billing metadata is immutable';

-- statement-breakpoint

CREATE TRIGGER billing_period_details_delete BEFORE DELETE ON billing_period_details
FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='Billing metadata is immutable';

-- statement-breakpoint

CREATE TRIGGER billing_bill_details_update BEFORE UPDATE ON billing_bill_details
FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='Billing metadata is immutable';

-- statement-breakpoint

CREATE TRIGGER billing_bill_details_delete BEFORE DELETE ON billing_bill_details
FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='Billing metadata is immutable';

-- statement-breakpoint

CREATE TRIGGER billing_discount_details_update BEFORE UPDATE ON billing_discount_details
FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='Billing metadata is immutable';

-- statement-breakpoint

CREATE TRIGGER billing_discount_details_delete BEFORE DELETE ON billing_discount_details
FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='Billing metadata is immutable';

-- statement-breakpoint

CREATE TRIGGER one_time_charge_applications_update BEFORE UPDATE ON one_time_charge_applications
FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='Billing metadata is immutable';

-- statement-breakpoint

CREATE TRIGGER one_time_charge_applications_delete BEFORE DELETE ON one_time_charge_applications
FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='Billing metadata is immutable';

-- statement-breakpoint

CREATE TRIGGER billing_run_delete BEFORE DELETE ON billing_generation_runs
FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='Billing generation history is immutable';

-- statement-breakpoint

CREATE TRIGGER billing_run_update BEFORE UPDATE ON billing_generation_runs
FOR EACH ROW
BEGIN
  IF OLD.status<>'STARTED' OR NEW.status<>'COMPLETED' OR NEW.id<>OLD.id OR NEW.society_id<>OLD.society_id OR NEW.period_id<>OLD.period_id OR NEW.idempotency_key<>OLD.idempotency_key OR NEW.request_hash<>OLD.request_hash OR NEW.preview_hash<>OLD.preview_hash OR NEW.recorded_by_membership_id<>OLD.recorded_by_membership_id OR NEW.created_at<>OLD.created_at THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='Only completion of a billing run is permitted';
  END IF;
END;

-- statement-breakpoint

CREATE TRIGGER maintenance_charge_configurations_immutable_update BEFORE UPDATE ON maintenance_charge_configurations
FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='Append a new billing configuration or period';

-- statement-breakpoint

CREATE TRIGGER maintenance_charge_configurations_immutable_delete BEFORE DELETE ON maintenance_charge_configurations
FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='Append a new billing configuration or period';

-- statement-breakpoint

CREATE TRIGGER billing_periods_immutable_update BEFORE UPDATE ON billing_periods
FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='Append a new billing configuration or period';

-- statement-breakpoint

CREATE TRIGGER billing_periods_immutable_delete BEFORE DELETE ON billing_periods
FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='Append a new billing configuration or period';

-- statement-breakpoint

CREATE TRIGGER billing_configuration_scope BEFORE INSERT ON maintenance_configuration_details
FOR EACH ROW
BEGIN
  DECLARE target_flat BIGINT UNSIGNED;
  SELECT flat_id INTO target_flat FROM maintenance_charge_configurations WHERE society_id=NEW.society_id AND id=NEW.configuration_id;
  IF (NEW.scope='FLAT' AND target_flat IS NULL) OR (NEW.scope<>'FLAT' AND target_flat IS NOT NULL) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='Configuration scope and target disagree';
  END IF;
END;

-- statement-breakpoint

CREATE TRIGGER billing_issue_totals BEFORE UPDATE ON bills
FOR EACH ROW
BEGIN
  DECLARE item_total DECIMAL(12,2);
  DECLARE credits DECIMAL(12,2);
  IF NEW.status='ISSUED' AND OLD.status='DRAFT' AND EXISTS(SELECT 1 FROM billing_bill_details WHERE society_id=NEW.society_id AND bill_id=NEW.id) THEN
    SELECT COALESCE(SUM(amount),0) INTO item_total FROM bill_items WHERE society_id=NEW.society_id AND bill_id=NEW.id;
    SELECT COALESCE(SUM(amount),0) INTO credits FROM bill_adjustments WHERE society_id=NEW.society_id AND bill_id=NEW.id AND direction='CREDIT';
    IF item_total<>NEW.total_amount OR credits>item_total THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='Bill totals must match immutable item and discount amounts';
    END IF;
  END IF;
END;
