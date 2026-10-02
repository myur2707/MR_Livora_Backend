-- Operator account changes must revoke credentials even when no HTTP request observes disablement.
CREATE TRIGGER users_revoke_authentication AFTER UPDATE ON users
FOR EACH ROW
BEGIN
  IF (OLD.status <> NEW.status AND NEW.status <> 'ACTIVE')
      OR NOT (OLD.password_hash <=> NEW.password_hash) THEN
    UPDATE auth_sessions SET revoked_at = UTC_TIMESTAMP(6)
      WHERE user_id = NEW.id AND revoked_at IS NULL;
    UPDATE password_reset_tokens SET consumed_at = GREATEST(UTC_TIMESTAMP(6), created_at)
      WHERE user_id = NEW.id AND consumed_at IS NULL;
  END IF;
END;
