-- Additive baseline. Default foreign-key actions are RESTRICT / NO ACTION.
-- Execute through the migration runner; each boundary separates a whole statement.

CREATE TABLE maintenance_charge_types (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  society_id BIGINT UNSIGNED NOT NULL,
  code VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  name VARCHAR(100) NOT NULL,
  archived_at DATETIME(6) NULL,
  UNIQUE KEY uq_maintenance_charge_types_code (society_id, code),
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (id),
  UNIQUE KEY uq_maintenance_charge_types_scope (society_id, id),
  CONSTRAINT fk_maintenance_charge_types_society FOREIGN KEY (society_id) REFERENCES societies (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_ci;

-- statement-breakpoint

CREATE TABLE maintenance_charge_configurations (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  society_id BIGINT UNSIGNED NOT NULL,
  charge_type_id BIGINT UNSIGNED NOT NULL,
  flat_id BIGINT UNSIGNED NULL,
  calculation_method VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT 'FLAT_RATE',
  CHECK (calculation_method IN ('FLAT_RATE', 'PER_SQ_FT')),
  rate DECIMAL(12,2) NOT NULL,
  effective_from DATE NOT NULL,
  effective_until DATE NULL,
  version INT UNSIGNED NOT NULL,
  flat_scope BIGINT UNSIGNED GENERATED ALWAYS AS (COALESCE(flat_id, 0)) STORED,
  UNIQUE KEY uq_charge_config_version (society_id, charge_type_id, flat_scope, version),
  KEY ix_charge_config_effective (society_id, charge_type_id, effective_from, effective_until),
  CHECK (rate >= 0 AND version > 0),
  CHECK (effective_until IS NULL OR effective_until >= effective_from),
  CONSTRAINT fk_charge_config_type FOREIGN KEY (society_id, charge_type_id) REFERENCES maintenance_charge_types (society_id, id),
  CONSTRAINT fk_charge_config_flat FOREIGN KEY (society_id, flat_id) REFERENCES flats (society_id, id),
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (id),
  UNIQUE KEY uq_maintenance_charge_configurations_scope (society_id, id),
  CONSTRAINT fk_maintenance_charge_configurations_society FOREIGN KEY (society_id) REFERENCES societies (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_ci;

-- statement-breakpoint

CREATE TABLE billing_periods (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  society_id BIGINT UNSIGNED NOT NULL,
  code VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  starts_on DATE NOT NULL,
  ends_on DATE NOT NULL,
  due_on DATE NOT NULL,
  UNIQUE KEY uq_billing_periods_code (society_id, code),
  UNIQUE KEY uq_billing_periods_dates (society_id, starts_on, ends_on),
  CHECK (ends_on >= starts_on AND due_on >= starts_on),
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (id),
  UNIQUE KEY uq_billing_periods_scope (society_id, id),
  CONSTRAINT fk_billing_periods_society FOREIGN KEY (society_id) REFERENCES societies (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_ci;

-- statement-breakpoint

CREATE TABLE bills (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  society_id BIGINT UNSIGNED NOT NULL,
  billing_period_id BIGINT UNSIGNED NOT NULL,
  flat_id BIGINT UNSIGNED NOT NULL,
  bill_number VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  status VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT 'DRAFT',
  CHECK (status IN ('DRAFT', 'ISSUED')),
  total_amount DECIMAL(12,2) NOT NULL,
  issued_at DATETIME(6) NULL,
  issued_by_membership_id BIGINT UNSIGNED NULL,
  UNIQUE KEY uq_bills_number (society_id, bill_number),
  UNIQUE KEY uq_bills_flat_period (society_id, flat_id, billing_period_id),
  UNIQUE KEY uq_bills_flat_scope (society_id, id, flat_id),
  KEY ix_bills_period_status (society_id, billing_period_id, status),
  CHECK (total_amount >= 0),
  CHECK ((status = 'ISSUED' AND issued_at IS NOT NULL AND issued_by_membership_id IS NOT NULL) OR (status = 'DRAFT' AND issued_at IS NULL AND issued_by_membership_id IS NULL)),
  CONSTRAINT fk_bills_period FOREIGN KEY (society_id, billing_period_id) REFERENCES billing_periods (society_id, id),
  CONSTRAINT fk_bills_flat FOREIGN KEY (society_id, flat_id) REFERENCES flats (society_id, id),
  CONSTRAINT fk_bills_issuer FOREIGN KEY (society_id, issued_by_membership_id) REFERENCES society_memberships (society_id, id),
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (id),
  UNIQUE KEY uq_bills_scope (society_id, id),
  CONSTRAINT fk_bills_society FOREIGN KEY (society_id) REFERENCES societies (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_ci;

-- statement-breakpoint

CREATE TABLE bill_items (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  society_id BIGINT UNSIGNED NOT NULL,
  bill_id BIGINT UNSIGNED NOT NULL,
  charge_configuration_id BIGINT UNSIGNED NOT NULL,
  line_number SMALLINT UNSIGNED NOT NULL,
  description VARCHAR(255) NOT NULL,
  quantity DECIMAL(10,2) NOT NULL,
  unit_rate DECIMAL(12,2) NOT NULL,
  amount DECIMAL(12,2) NOT NULL,
  UNIQUE KEY uq_bill_items_line (society_id, bill_id, line_number),
  CHECK (quantity > 0 AND unit_rate >= 0 AND amount >= 0 AND line_number > 0),
  CHECK (amount = ROUND(quantity * unit_rate, 2)),
  CONSTRAINT fk_bill_items_bill FOREIGN KEY (society_id, bill_id) REFERENCES bills (society_id, id),
  CONSTRAINT fk_bill_items_configuration FOREIGN KEY (society_id, charge_configuration_id) REFERENCES maintenance_charge_configurations (society_id, id),
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (id),
  UNIQUE KEY uq_bill_items_scope (society_id, id),
  CONSTRAINT fk_bill_items_society FOREIGN KEY (society_id) REFERENCES societies (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_ci;

-- statement-breakpoint

CREATE TABLE bill_adjustments (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  society_id BIGINT UNSIGNED NOT NULL,
  bill_id BIGINT UNSIGNED NOT NULL,
  direction VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT 'CREDIT',
  CHECK (direction IN ('CREDIT', 'DEBIT')),
  amount DECIMAL(12,2) NOT NULL,
  reason VARCHAR(500) NOT NULL,
  idempotency_key VARCHAR(80) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  recorded_by_membership_id BIGINT UNSIGNED NOT NULL,
  UNIQUE KEY uq_bill_adjustments_request (society_id, idempotency_key),
  CHECK (amount > 0),
  CONSTRAINT fk_bill_adjustments_bill FOREIGN KEY (society_id, bill_id) REFERENCES bills (society_id, id),
  CONSTRAINT fk_bill_adjustments_recorder FOREIGN KEY (society_id, recorded_by_membership_id) REFERENCES society_memberships (society_id, id),
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (id),
  UNIQUE KEY uq_bill_adjustments_scope (society_id, id),
  CONSTRAINT fk_bill_adjustments_society FOREIGN KEY (society_id) REFERENCES societies (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_ci;

-- statement-breakpoint

CREATE TABLE payments (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  society_id BIGINT UNSIGNED NOT NULL,
  flat_id BIGINT UNSIGNED NOT NULL,
  payer_person_id BIGINT UNSIGNED NOT NULL,
  method VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT 'CASH',
  CHECK (method IN ('CASH', 'UPI', 'BANK_TRANSFER', 'CHEQUE', 'OTHER')),
  payment_date DATE NOT NULL,
  amount DECIMAL(12,2) NOT NULL,
  reference VARCHAR(128) NULL,
  collected_by_membership_id BIGINT UNSIGNED NULL,
  recorded_by_membership_id BIGINT UNSIGNED NOT NULL,
  notes VARCHAR(1000) NULL,
  idempotency_key VARCHAR(80) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  UNIQUE KEY uq_payments_request (society_id, idempotency_key),
  UNIQUE KEY uq_payments_flat_scope (society_id, id, flat_id),
  KEY ix_payments_date (society_id, payment_date, id),
  KEY ix_payments_reference (society_id, method, reference),
  CHECK (amount > 0),
  CHECK (method <> 'CASH' OR collected_by_membership_id IS NOT NULL),
  CONSTRAINT fk_payments_flat FOREIGN KEY (society_id, flat_id) REFERENCES flats (society_id, id),
  CONSTRAINT fk_payments_payer FOREIGN KEY (society_id, payer_person_id) REFERENCES society_persons (society_id, person_id),
  CONSTRAINT fk_payments_collector FOREIGN KEY (society_id, collected_by_membership_id) REFERENCES society_memberships (society_id, id),
  CONSTRAINT fk_payments_recorder FOREIGN KEY (society_id, recorded_by_membership_id) REFERENCES society_memberships (society_id, id),
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (id),
  UNIQUE KEY uq_payments_scope (society_id, id),
  CONSTRAINT fk_payments_society FOREIGN KEY (society_id) REFERENCES societies (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_ci;

-- statement-breakpoint

CREATE TABLE payment_allocations (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  society_id BIGINT UNSIGNED NOT NULL,
  payment_id BIGINT UNSIGNED NOT NULL,
  bill_id BIGINT UNSIGNED NOT NULL,
  flat_id BIGINT UNSIGNED NOT NULL,
  amount DECIMAL(12,2) NOT NULL,
  UNIQUE KEY uq_payment_allocations_pair (society_id, payment_id, bill_id),
  KEY ix_payment_allocations_bill (society_id, bill_id),
  CHECK (amount > 0),
  CONSTRAINT fk_payment_allocations_payment FOREIGN KEY (society_id, payment_id, flat_id) REFERENCES payments (society_id, id, flat_id),
  CONSTRAINT fk_payment_allocations_bill FOREIGN KEY (society_id, bill_id, flat_id) REFERENCES bills (society_id, id, flat_id),
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (id),
  UNIQUE KEY uq_payment_allocations_scope (society_id, id),
  CONSTRAINT fk_payment_allocations_society FOREIGN KEY (society_id) REFERENCES societies (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_ci;

-- statement-breakpoint

CREATE TABLE payment_reversals (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  society_id BIGINT UNSIGNED NOT NULL,
  payment_id BIGINT UNSIGNED NOT NULL,
  reason VARCHAR(500) NOT NULL,
  reversed_by_membership_id BIGINT UNSIGNED NOT NULL,
  idempotency_key VARCHAR(80) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  UNIQUE KEY uq_payment_reversals_payment (society_id, payment_id),
  UNIQUE KEY uq_payment_reversals_request (society_id, idempotency_key),
  CONSTRAINT fk_payment_reversals_payment FOREIGN KEY (society_id, payment_id) REFERENCES payments (society_id, id),
  CONSTRAINT fk_payment_reversals_actor FOREIGN KEY (society_id, reversed_by_membership_id) REFERENCES society_memberships (society_id, id),
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (id),
  UNIQUE KEY uq_payment_reversals_scope (society_id, id),
  CONSTRAINT fk_payment_reversals_society FOREIGN KEY (society_id) REFERENCES societies (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_ci;

-- statement-breakpoint

CREATE TABLE receipts (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  society_id BIGINT UNSIGNED NOT NULL,
  payment_id BIGINT UNSIGNED NOT NULL,
  receipt_number VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  issued_at DATETIME(6) NOT NULL,
  issued_by_membership_id BIGINT UNSIGNED NOT NULL,
  UNIQUE KEY uq_receipts_payment (society_id, payment_id),
  UNIQUE KEY uq_receipts_number (society_id, receipt_number),
  CONSTRAINT fk_receipts_payment FOREIGN KEY (society_id, payment_id) REFERENCES payments (society_id, id),
  CONSTRAINT fk_receipts_issuer FOREIGN KEY (society_id, issued_by_membership_id) REFERENCES society_memberships (society_id, id),
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (id),
  UNIQUE KEY uq_receipts_scope (society_id, id),
  CONSTRAINT fk_receipts_society FOREIGN KEY (society_id) REFERENCES societies (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_ci;

