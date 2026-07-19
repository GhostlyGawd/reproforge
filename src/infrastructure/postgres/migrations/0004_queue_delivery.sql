DROP INDEX outbox_pending_idx;

ALTER TABLE outbox_events
  DROP CONSTRAINT outbox_status_valid,
  DROP CONSTRAINT outbox_delivery_state,
  ADD COLUMN claim_owner text,
  ADD COLUMN claim_expires_at timestamptz,
  ADD COLUMN provider_message_id text,
  ADD COLUMN version bigint NOT NULL DEFAULT 1,
  ADD COLUMN updated_at timestamptz;

UPDATE outbox_events SET updated_at = created_at WHERE updated_at IS NULL;

ALTER TABLE outbox_events
  ALTER COLUMN updated_at SET NOT NULL,
  ALTER COLUMN updated_at SET DEFAULT CURRENT_TIMESTAMP,
  ADD CONSTRAINT outbox_status_valid
    CHECK (status IN ('PENDING', 'SENDING', 'DELIVERED', 'DEAD')),
  ADD CONSTRAINT outbox_claim_owner_format
    CHECK (
      claim_owner IS NULL
      OR claim_owner ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
    ),
  ADD CONSTRAINT outbox_provider_message_id_length
    CHECK (
      provider_message_id IS NULL
      OR length(provider_message_id) BETWEEN 1 AND 512
    ),
  ADD CONSTRAINT outbox_version_positive CHECK (version >= 1),
  ADD CONSTRAINT outbox_updated_timestamp_order
    CHECK (updated_at >= created_at),
  ADD CONSTRAINT outbox_delivery_state
    CHECK (
      (status = 'PENDING' AND delivered_at IS NULL
        AND claim_owner IS NULL AND claim_expires_at IS NULL
        AND provider_message_id IS NULL)
      OR
      (status = 'SENDING' AND delivered_at IS NULL
        AND claim_owner IS NOT NULL AND claim_expires_at IS NOT NULL
        AND claim_expires_at > updated_at AND provider_message_id IS NULL)
      OR
      (status = 'DELIVERED' AND delivered_at IS NOT NULL
        AND claim_owner IS NULL AND claim_expires_at IS NULL)
      OR
      (status = 'DEAD' AND delivered_at IS NULL
        AND claim_owner IS NULL AND claim_expires_at IS NULL
        AND provider_message_id IS NULL AND last_error_code IS NOT NULL)
    );

CREATE TRIGGER outbox_events_successor_version
BEFORE UPDATE ON outbox_events
FOR EACH ROW EXECUTE FUNCTION reproforge_enforce_successor_version();

CREATE INDEX outbox_pending_idx
  ON outbox_events (next_attempt_at, created_at)
  WHERE status IN ('PENDING', 'SENDING');

CREATE FUNCTION reproforge_enforce_job_transition()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.state = OLD.state THEN
    RETURN NEW;
  END IF;
  IF OLD.state = 'QUEUED' AND NEW.state IN ('RUNNING', 'CANCELLED') THEN
    RETURN NEW;
  END IF;
  IF OLD.state = 'RUNNING'
     AND NEW.state IN ('QUEUED', 'SUCCEEDED', 'FAILED', 'CANCELLED') THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'invalid durable job transition: % -> %', OLD.state, NEW.state
    USING ERRCODE = '23514';
END;
$$;

CREATE TRIGGER jobs_valid_transition
BEFORE UPDATE ON jobs
FOR EACH ROW EXECUTE FUNCTION reproforge_enforce_job_transition();

ALTER TABLE jobs
  ADD CONSTRAINT jobs_failure_code_sanitized
    CHECK (
      failure_code IS NULL
      OR failure_code ~ '^[A-Z][A-Z0-9_]{0,95}$'
    ),
  ADD CONSTRAINT jobs_failure_message_bounded
    CHECK (
      failure_message IS NULL
      OR length(failure_message) BETWEEN 1 AND 512
    );

ALTER TABLE run_evidence
  ADD COLUMN lease_owner text,
  ADD CONSTRAINT run_evidence_lease_owner_format
    CHECK (
      lease_owner IS NULL
      OR lease_owner ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
    );

CREATE FUNCTION reproforge_require_evidence_lease()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.lease_owner IS NULL OR NOT EXISTS (
    SELECT 1
      FROM jobs
     WHERE tenant_id = NEW.tenant_id
       AND id = NEW.job_id
       AND case_id = NEW.case_id
       AND state = 'RUNNING'
       AND attempt = NEW.attempt
       AND lease_owner = NEW.lease_owner
       AND lease_acquired_at <= NEW.created_at
       AND lease_expires_at > NEW.created_at
  ) THEN
    RAISE EXCEPTION 'attempt evidence requires the active lease owner'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER run_evidence_requires_active_lease
BEFORE INSERT ON run_evidence
FOR EACH ROW EXECUTE FUNCTION reproforge_require_evidence_lease();
