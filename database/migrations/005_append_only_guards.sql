-- Additive baseline. Default foreign-key actions are RESTRICT / NO ACTION.
-- Execute through the migration runner; each boundary separates a whole statement.

CREATE TRIGGER guard_payments_update
BEFORE UPDATE ON payments FOR EACH ROW
SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Append-only record: use a documented correction or reversal';

-- statement-breakpoint

CREATE TRIGGER guard_payments_delete
BEFORE DELETE ON payments FOR EACH ROW
SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Append-only record: use a documented correction or reversal';

-- statement-breakpoint

CREATE TRIGGER guard_payment_allocations_update
BEFORE UPDATE ON payment_allocations FOR EACH ROW
SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Append-only record: use a documented correction or reversal';

-- statement-breakpoint

CREATE TRIGGER guard_payment_allocations_delete
BEFORE DELETE ON payment_allocations FOR EACH ROW
SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Append-only record: use a documented correction or reversal';

-- statement-breakpoint

CREATE TRIGGER guard_payment_reversals_update
BEFORE UPDATE ON payment_reversals FOR EACH ROW
SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Append-only record: use a documented correction or reversal';

-- statement-breakpoint

CREATE TRIGGER guard_payment_reversals_delete
BEFORE DELETE ON payment_reversals FOR EACH ROW
SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Append-only record: use a documented correction or reversal';

-- statement-breakpoint

CREATE TRIGGER guard_receipts_update
BEFORE UPDATE ON receipts FOR EACH ROW
SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Append-only record: use a documented correction or reversal';

-- statement-breakpoint

CREATE TRIGGER guard_receipts_delete
BEFORE DELETE ON receipts FOR EACH ROW
SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Append-only record: use a documented correction or reversal';

-- statement-breakpoint

CREATE TRIGGER guard_bill_adjustments_update
BEFORE UPDATE ON bill_adjustments FOR EACH ROW
SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Append-only record: use a documented correction or reversal';

-- statement-breakpoint

CREATE TRIGGER guard_bill_adjustments_delete
BEFORE DELETE ON bill_adjustments FOR EACH ROW
SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Append-only record: use a documented correction or reversal';

-- statement-breakpoint

CREATE TRIGGER guard_audit_logs_update
BEFORE UPDATE ON audit_logs FOR EACH ROW
SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Append-only record: use a documented correction or reversal';

-- statement-breakpoint

CREATE TRIGGER guard_audit_logs_delete
BEFORE DELETE ON audit_logs FOR EACH ROW
SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Append-only record: use a documented correction or reversal';

-- statement-breakpoint

CREATE TRIGGER guard_bills_update
BEFORE UPDATE ON bills FOR EACH ROW
BEGIN
  IF OLD.status = 'ISSUED' THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Issued bill is immutable: use a bill adjustment';
  END IF;
END;

-- statement-breakpoint

CREATE TRIGGER guard_bills_delete
BEFORE DELETE ON bills FOR EACH ROW
BEGIN
  IF OLD.status = 'ISSUED' THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Issued bill is immutable: use a bill adjustment';
  END IF;
END;

-- statement-breakpoint

CREATE TRIGGER guard_bill_items_insert
BEFORE INSERT ON bill_items FOR EACH ROW
BEGIN
  DECLARE bill_state VARCHAR(32);
  SELECT status INTO bill_state FROM bills WHERE society_id = NEW.society_id AND id = NEW.bill_id FOR UPDATE;
  IF bill_state = 'ISSUED' THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Issued bill items are immutable';
  END IF;
END;

-- statement-breakpoint

CREATE TRIGGER guard_bill_items_update
BEFORE UPDATE ON bill_items FOR EACH ROW
BEGIN
  DECLARE bill_state VARCHAR(32);
  SELECT status INTO bill_state FROM bills WHERE society_id = OLD.society_id AND id = OLD.bill_id FOR UPDATE;
  IF bill_state = 'ISSUED' THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Issued bill items are immutable';
  END IF;
  SELECT status INTO bill_state FROM bills WHERE society_id = NEW.society_id AND id = NEW.bill_id FOR UPDATE;
  IF bill_state = 'ISSUED' THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Issued bill items are immutable';
  END IF;
END;

-- statement-breakpoint

CREATE TRIGGER guard_bill_items_delete
BEFORE DELETE ON bill_items FOR EACH ROW
BEGIN
  DECLARE bill_state VARCHAR(32);
  SELECT status INTO bill_state FROM bills WHERE society_id = OLD.society_id AND id = OLD.bill_id FOR UPDATE;
  IF bill_state = 'ISSUED' THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Issued bill items are immutable';
  END IF;
END;

