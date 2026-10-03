-- Additive payment recording, refunds and immutable receipt snapshots.

CREATE TABLE payment_details (
 id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
 society_id BIGINT UNSIGNED NOT NULL,
 payment_id BIGINT UNSIGNED NOT NULL,
 receipt_id BIGINT UNSIGNED NOT NULL,
 society_name VARCHAR(200) NOT NULL, currency CHAR(3) CHARACTER SET ascii NOT NULL,
 building_code VARCHAR(64) NOT NULL, flat_number VARCHAR(32) NOT NULL,
 payer_name VARCHAR(160) NOT NULL, collector_name VARCHAR(160) NOT NULL, recorder_name VARCHAR(160) NOT NULL,
 UNIQUE KEY uq_payment_details_payment(society_id,payment_id),
 UNIQUE KEY uq_payment_details_receipt(society_id,receipt_id),
 FOREIGN KEY(society_id,payment_id) REFERENCES payments(society_id,id),
 FOREIGN KEY(society_id,receipt_id) REFERENCES receipts(society_id,id),
 created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
 PRIMARY KEY(id),
 UNIQUE KEY uq_payment_details_scope(society_id,id),
 FOREIGN KEY(society_id) REFERENCES societies(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_ci;

-- statement-breakpoint

CREATE TABLE payment_refunds (
 id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
 society_id BIGINT UNSIGNED NOT NULL,
 payment_id BIGINT UNSIGNED NOT NULL,
 amount DECIMAL(12,2) NOT NULL CHECK(amount>0),
 refund_date DATE NOT NULL,
 method VARCHAR(32) CHARACTER SET ascii NOT NULL CHECK(method IN ('CASH','UPI','BANK_TRANSFER','CHEQUE')),
 reference VARCHAR(128) NULL, reason VARCHAR(500) NOT NULL,
 recorded_by_membership_id BIGINT UNSIGNED NOT NULL,
 UNIQUE KEY uq_payment_refunds_parent(society_id,id,payment_id),
 KEY ix_payment_refunds_date(society_id,refund_date,id),
 KEY ix_payment_refunds_payment(society_id,payment_id),
 FOREIGN KEY(society_id,payment_id) REFERENCES payments(society_id,id),
 FOREIGN KEY(society_id,recorded_by_membership_id) REFERENCES society_memberships(society_id,id),
 created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
 PRIMARY KEY(id),
 UNIQUE KEY uq_payment_refunds_scope(society_id,id),
 FOREIGN KEY(society_id) REFERENCES societies(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_ci;

-- statement-breakpoint

CREATE TABLE payment_refund_allocations (
 id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
 society_id BIGINT UNSIGNED NOT NULL,
 refund_id BIGINT UNSIGNED NOT NULL, payment_id BIGINT UNSIGNED NOT NULL,
 allocation_id BIGINT UNSIGNED NOT NULL, bill_id BIGINT UNSIGNED NOT NULL, flat_id BIGINT UNSIGNED NOT NULL,
 amount DECIMAL(12,2) NOT NULL CHECK(amount>0),
 UNIQUE KEY uq_payment_refund_allocations_pair(society_id,refund_id,allocation_id),
 KEY ix_payment_refund_allocations_bill(society_id,bill_id),
 KEY ix_payment_refund_allocations_original(society_id,allocation_id),
 FOREIGN KEY(society_id,refund_id,payment_id) REFERENCES payment_refunds(society_id,id,payment_id),
 FOREIGN KEY(society_id,allocation_id) REFERENCES payment_allocations(society_id,id),
 FOREIGN KEY(society_id,payment_id,flat_id) REFERENCES payments(society_id,id,flat_id),
 FOREIGN KEY(society_id,bill_id,flat_id) REFERENCES bills(society_id,id,flat_id),
 created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
 PRIMARY KEY(id),
 UNIQUE KEY uq_payment_refund_allocations_scope(society_id,id),
 FOREIGN KEY(society_id) REFERENCES societies(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_ci;

-- statement-breakpoint

CREATE TABLE payment_reversal_details (
 id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
 society_id BIGINT UNSIGNED NOT NULL,
 reversal_id BIGINT UNSIGNED NOT NULL,
 operation_date DATE NOT NULL,
 UNIQUE KEY uq_payment_reversal_details_reversal(society_id,reversal_id),
 KEY ix_payment_reversal_details_date(society_id,operation_date,id),
 FOREIGN KEY(society_id,reversal_id) REFERENCES payment_reversals(society_id,id),
 created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
 PRIMARY KEY(id),
 UNIQUE KEY uq_payment_reversal_details_scope(society_id,id),
 FOREIGN KEY(society_id) REFERENCES societies(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_ci;

-- statement-breakpoint

CREATE TABLE payment_commands (
 id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
 society_id BIGINT UNSIGNED NOT NULL,
 idempotency_key VARCHAR(80) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
 request_hash BINARY(32) NOT NULL,
 kind VARCHAR(16) CHARACTER SET ascii NOT NULL CHECK(kind IN ('RECORD','REVERSE','REFUND','CORRECT')),
 payment_id BIGINT UNSIGNED NOT NULL,
 refund_id BIGINT UNSIGNED NULL, reversal_id BIGINT UNSIGNED NULL, replacement_payment_id BIGINT UNSIGNED NULL,
 UNIQUE KEY uq_payment_commands_request(society_id,idempotency_key),
 UNIQUE KEY uq_payment_commands_refund(society_id,refund_id),
 UNIQUE KEY uq_payment_commands_reversal(society_id,reversal_id),
 UNIQUE KEY uq_payment_commands_replacement(society_id,replacement_payment_id),
 KEY ix_payment_commands_payment(society_id,payment_id),
 CHECK((kind='RECORD' AND refund_id IS NULL AND reversal_id IS NULL AND replacement_payment_id IS NULL) OR (kind='REFUND' AND refund_id IS NOT NULL AND reversal_id IS NULL AND replacement_payment_id IS NULL) OR (kind='REVERSE' AND reversal_id IS NOT NULL AND refund_id IS NULL AND replacement_payment_id IS NULL) OR (kind='CORRECT' AND reversal_id IS NOT NULL AND refund_id IS NULL AND replacement_payment_id IS NOT NULL AND replacement_payment_id<>payment_id)),
 FOREIGN KEY(society_id,payment_id) REFERENCES payments(society_id,id),
 FOREIGN KEY(society_id,replacement_payment_id) REFERENCES payments(society_id,id),
 FOREIGN KEY(society_id,refund_id,payment_id) REFERENCES payment_refunds(society_id,id,payment_id),
 FOREIGN KEY(society_id,reversal_id) REFERENCES payment_reversals(society_id,id),
 created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
 PRIMARY KEY(id),
 UNIQUE KEY uq_payment_commands_scope(society_id,id),
 FOREIGN KEY(society_id) REFERENCES societies(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_ci;

-- statement-breakpoint

CREATE TRIGGER payment_details_update BEFORE UPDATE ON payment_details FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='Completed payment history is immutable';

-- statement-breakpoint

CREATE TRIGGER payment_details_delete BEFORE DELETE ON payment_details FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='Completed payment history is immutable';

-- statement-breakpoint

CREATE TRIGGER payment_refunds_update BEFORE UPDATE ON payment_refunds FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='Completed payment history is immutable';

-- statement-breakpoint

CREATE TRIGGER payment_refunds_delete BEFORE DELETE ON payment_refunds FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='Completed payment history is immutable';

-- statement-breakpoint

CREATE TRIGGER payment_refund_allocations_update BEFORE UPDATE ON payment_refund_allocations FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='Completed payment history is immutable';

-- statement-breakpoint

CREATE TRIGGER payment_refund_allocations_delete BEFORE DELETE ON payment_refund_allocations FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='Completed payment history is immutable';

-- statement-breakpoint

CREATE TRIGGER payment_reversal_details_update BEFORE UPDATE ON payment_reversal_details FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='Completed payment history is immutable';

-- statement-breakpoint

CREATE TRIGGER payment_reversal_details_delete BEFORE DELETE ON payment_reversal_details FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='Completed payment history is immutable';

-- statement-breakpoint

CREATE TRIGGER payment_commands_update BEFORE UPDATE ON payment_commands FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='Completed payment history is immutable';

-- statement-breakpoint

CREATE TRIGGER payment_commands_delete BEFORE DELETE ON payment_commands FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='Completed payment history is immutable';

-- statement-breakpoint

CREATE TRIGGER payment_details_seal BEFORE INSERT ON payment_details FOR EACH ROW
BEGIN
 DECLARE value_amount DECIMAL(12,2);
 SELECT amount INTO value_amount FROM payments WHERE society_id=NEW.society_id AND id=NEW.payment_id FOR UPDATE;
 IF value_amount<>(SELECT COALESCE(SUM(amount),0) FROM payment_allocations WHERE society_id=NEW.society_id AND payment_id=NEW.payment_id)
 OR NOT EXISTS(SELECT 1 FROM receipts WHERE society_id=NEW.society_id AND id=NEW.receipt_id AND payment_id=NEW.payment_id)
 THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='Payment allocations or receipt are incomplete'; END IF;
END;

-- statement-breakpoint

CREATE TRIGGER payment_allocations_insert_guard BEFORE INSERT ON payment_allocations FOR EACH ROW
guard: BEGIN
 DECLARE value_amount DECIMAL(12,2); DECLARE value_status VARCHAR(32);
 IF (EXISTS(SELECT 1 FROM payments WHERE society_id=NEW.society_id AND id=NEW.payment_id AND flat_id=NEW.flat_id)=0)
 OR NOT EXISTS(SELECT 1 FROM bills WHERE society_id=NEW.society_id AND id=NEW.bill_id AND flat_id=NEW.flat_id)
 THEN LEAVE guard; END IF;
 SELECT amount INTO value_amount FROM payments WHERE society_id=NEW.society_id AND id=NEW.payment_id FOR UPDATE;
 IF EXISTS(SELECT 1 FROM payment_details WHERE society_id=NEW.society_id AND payment_id=NEW.payment_id)
 OR EXISTS(SELECT 1 FROM payment_reversals WHERE society_id=NEW.society_id AND payment_id=NEW.payment_id)
 OR NEW.amount+(SELECT COALESCE(SUM(amount),0) FROM payment_allocations WHERE society_id=NEW.society_id AND payment_id=NEW.payment_id)>value_amount
 THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='Payment is sealed or allocation exceeds amount'; END IF;
 SELECT status INTO value_status FROM bills WHERE society_id=NEW.society_id AND id=NEW.bill_id FOR UPDATE;
 IF value_status<>'ISSUED' THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='Only issued bills accept payment'; END IF;
END;

-- statement-breakpoint

CREATE TRIGGER payment_refunds_insert_guard BEFORE INSERT ON payment_refunds FOR EACH ROW
BEGIN
 DECLARE value_amount DECIMAL(12,2);
 SELECT amount INTO value_amount FROM payments WHERE society_id=NEW.society_id AND id=NEW.payment_id FOR UPDATE;
 IF EXISTS(SELECT 1 FROM payment_reversals WHERE society_id=NEW.society_id AND payment_id=NEW.payment_id)
 OR NEW.amount+(SELECT COALESCE(SUM(amount),0) FROM payment_refunds WHERE society_id=NEW.society_id AND payment_id=NEW.payment_id)>value_amount
 THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='Refund exceeds remaining payment'; END IF;
END;

-- statement-breakpoint

CREATE TRIGGER payment_refund_allocations_guard BEFORE INSERT ON payment_refund_allocations FOR EACH ROW
BEGIN
 DECLARE value_amount DECIMAL(12,2); DECLARE value_payment BIGINT UNSIGNED;
 SELECT amount,payment_id INTO value_amount,value_payment FROM payment_allocations WHERE society_id=NEW.society_id AND id=NEW.allocation_id AND bill_id=NEW.bill_id AND flat_id=NEW.flat_id FOR UPDATE;
 IF value_amount IS NULL OR value_payment<>NEW.payment_id
 OR EXISTS(SELECT 1 FROM payment_commands WHERE society_id=NEW.society_id AND refund_id=NEW.refund_id)
 OR NEW.amount+(SELECT COALESCE(SUM(amount),0) FROM payment_refund_allocations WHERE society_id=NEW.society_id AND allocation_id=NEW.allocation_id)>value_amount
 OR NEW.amount+(SELECT COALESCE(SUM(amount),0) FROM payment_refund_allocations WHERE society_id=NEW.society_id AND refund_id=NEW.refund_id)>(SELECT amount FROM payment_refunds WHERE society_id=NEW.society_id AND id=NEW.refund_id)
 THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='Refund allocation is invalid or sealed'; END IF;
END;

-- statement-breakpoint

CREATE TRIGGER payment_reversals_refund_guard BEFORE INSERT ON payment_reversals FOR EACH ROW
BEGIN
 DECLARE value_amount DECIMAL(12,2);
 SELECT amount INTO value_amount FROM payments WHERE society_id=NEW.society_id AND id=NEW.payment_id FOR UPDATE;
 IF EXISTS(SELECT 1 FROM payment_refunds WHERE society_id=NEW.society_id AND payment_id=NEW.payment_id)
 THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='Refunded payments cannot also be reversed'; END IF;
END;

-- statement-breakpoint

CREATE TRIGGER payment_commands_complete BEFORE INSERT ON payment_commands FOR EACH ROW
BEGIN
 IF NEW.kind='REFUND' AND (SELECT amount FROM payment_refunds WHERE society_id=NEW.society_id AND id=NEW.refund_id)<>(SELECT COALESCE(SUM(amount),0) FROM payment_refund_allocations WHERE society_id=NEW.society_id AND refund_id=NEW.refund_id)
 THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='Refund allocations are incomplete'; END IF;
 IF NEW.kind IN ('REVERSE','CORRECT') AND (NOT EXISTS(SELECT 1 FROM payment_reversals WHERE society_id=NEW.society_id AND id=NEW.reversal_id AND payment_id=NEW.payment_id) OR NOT EXISTS(SELECT 1 FROM payment_reversal_details WHERE society_id=NEW.society_id AND reversal_id=NEW.reversal_id))
 THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='Reversal is incomplete'; END IF;
 IF NEW.kind IN ('RECORD','CORRECT') AND NOT EXISTS(SELECT 1 FROM payment_details WHERE society_id=NEW.society_id AND payment_id=IF(NEW.kind='RECORD',NEW.payment_id,NEW.replacement_payment_id))
 THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='Payment is incomplete'; END IF;
END;
