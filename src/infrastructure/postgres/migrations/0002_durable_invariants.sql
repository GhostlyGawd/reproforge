CREATE FUNCTION reproforge_enforce_successor_version()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.version <> OLD.version + 1 THEN
    RAISE EXCEPTION 'optimistic version must advance by exactly one'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.updated_at < OLD.updated_at THEN
    RAISE EXCEPTION 'updated_at must not move backwards'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER cases_successor_version
BEFORE UPDATE ON cases
FOR EACH ROW EXECUTE FUNCTION reproforge_enforce_successor_version();

CREATE TRIGGER jobs_successor_version
BEFORE UPDATE ON jobs
FOR EACH ROW EXECUTE FUNCTION reproforge_enforce_successor_version();

CREATE TRIGGER deletion_requests_successor_version
BEFORE UPDATE ON deletion_requests
FOR EACH ROW EXECUTE FUNCTION reproforge_enforce_successor_version();

CREATE FUNCTION reproforge_reject_append_only_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME
    USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER run_evidence_append_only
BEFORE UPDATE OR DELETE ON run_evidence
FOR EACH ROW EXECUTE FUNCTION reproforge_reject_append_only_mutation();

CREATE TRIGGER audit_events_append_only
BEFORE UPDATE OR DELETE ON audit_events
FOR EACH ROW EXECUTE FUNCTION reproforge_reject_append_only_mutation();

CREATE FUNCTION reproforge_audit_metadata_is_sanitized(metadata jsonb)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
STRICT
AS $$
  SELECT jsonb_typeof(metadata) = 'object'
    AND NOT EXISTS (
      SELECT 1
        FROM jsonb_each(metadata) AS entry(key_name, entry_value)
       WHERE key_name ~* '(authorization|cookie|credential|password|secret|source|token|command)'
          OR jsonb_typeof(entry_value) NOT IN ('string', 'number', 'boolean', 'null')
    );
$$;

ALTER TABLE audit_events
  ADD CONSTRAINT audit_metadata_sanitized
  CHECK (reproforge_audit_metadata_is_sanitized(metadata));

ALTER TABLE deletion_requests
  ADD CONSTRAINT deletion_audit_tombstone_fk
  FOREIGN KEY (tenant_id, audit_tombstone_id)
  REFERENCES audit_events (tenant_id, id)
  ON DELETE RESTRICT;
