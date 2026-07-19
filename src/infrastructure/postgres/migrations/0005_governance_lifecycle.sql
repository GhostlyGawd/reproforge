ALTER TABLE quota_ledger
  ADD COLUMN case_id text,
  ADD COLUMN job_id text,
  ADD CONSTRAINT quota_job_identity_complete
    CHECK (
      (case_id IS NULL AND job_id IS NULL)
      OR (case_id IS NOT NULL AND job_id IS NOT NULL)
    ),
  ADD CONSTRAINT quota_job_fk
    FOREIGN KEY (tenant_id, case_id, job_id)
    REFERENCES jobs (tenant_id, case_id, id)
    ON DELETE RESTRICT;

CREATE INDEX quota_job_active_idx
  ON quota_ledger (tenant_id, job_id, resource, state)
  WHERE job_id IS NOT NULL AND state IN ('RESERVED', 'COMMITTED');

CREATE UNIQUE INDEX deletion_requests_one_active_idx
  ON deletion_requests (tenant_id)
  WHERE state IN ('REQUESTED', 'SCHEDULED', 'RUNNING');

ALTER TABLE deletion_requests
  ADD COLUMN claim_owner text,
  ADD COLUMN claim_expires_at timestamptz;

UPDATE deletion_requests
   SET state = 'SCHEDULED', version = version + 1,
       updated_at = greatest(updated_at, CURRENT_TIMESTAMP)
 WHERE state = 'RUNNING';

ALTER TABLE deletion_requests
  ADD CONSTRAINT deletion_claim_owner_format
    CHECK (
      claim_owner IS NULL
      OR claim_owner ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
    ),
  ADD CONSTRAINT deletion_claim_shape
    CHECK (
      (state = 'RUNNING' AND claim_owner IS NOT NULL
        AND claim_expires_at IS NOT NULL AND claim_expires_at > updated_at)
      OR
      (state <> 'RUNNING' AND claim_owner IS NULL AND claim_expires_at IS NULL)
    );

ALTER TABLE jobs
  ADD CONSTRAINT jobs_cancellation_shape
    CHECK (
      (state = 'CANCELLED'
        AND (
          (cancellation_requested_at IS NOT NULL AND cancelled_at IS NOT NULL)
          OR (cancellation_requested_at IS NULL AND cancelled_at IS NULL)
        ))
      OR
      (state <> 'CANCELLED'
        AND cancelled_at IS NULL
        AND (
          cancellation_requested_at IS NULL
          OR state = 'RUNNING'
        ))
    );

CREATE OR REPLACE FUNCTION reproforge_enforce_job_transition()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.state = OLD.state THEN
    RETURN NEW;
  END IF;
  IF NEW.state = 'CANCELLED'
     AND (NEW.cancellation_requested_at IS NULL OR NEW.cancelled_at IS NULL) THEN
    RAISE EXCEPTION 'durable cancellation requires request and completion timestamps'
      USING ERRCODE = '23514';
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

CREATE FUNCTION reproforge_require_new_cancellation_timestamps()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.state = 'CANCELLED'
     AND (NEW.cancellation_requested_at IS NULL OR NEW.cancelled_at IS NULL)
     AND (TG_OP = 'INSERT' OR OLD.state <> 'CANCELLED') THEN
    RAISE EXCEPTION 'durable cancellation requires request and completion timestamps'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER jobs_require_new_cancellation_timestamps
BEFORE INSERT OR UPDATE ON jobs
FOR EACH ROW EXECUTE FUNCTION reproforge_require_new_cancellation_timestamps();

CREATE FUNCTION reproforge_enforce_deletion_transition()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.state = OLD.state THEN
    RETURN NEW;
  END IF;
  IF OLD.state = 'REQUESTED' AND NEW.state IN ('SCHEDULED', 'RUNNING', 'FAILED') THEN
    RETURN NEW;
  END IF;
  IF OLD.state = 'SCHEDULED' AND NEW.state IN ('RUNNING', 'FAILED') THEN
    RETURN NEW;
  END IF;
  IF OLD.state = 'RUNNING' AND NEW.state IN ('COMPLETED', 'FAILED') THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'invalid deletion request transition: % -> %', OLD.state, NEW.state
    USING ERRCODE = '23514';
END;
$$;

CREATE TRIGGER deletion_requests_valid_transition
BEFORE UPDATE ON deletion_requests
FOR EACH ROW EXECUTE FUNCTION reproforge_enforce_deletion_transition();

CREATE FUNCTION reproforge_retention_purge_allowed(p_tenant_id text)
RETURNS boolean
LANGUAGE sql
STABLE
STRICT
AS $$
  SELECT EXISTS (
    SELECT 1
      FROM tenants t
      JOIN deletion_requests d ON d.tenant_id = t.id
     WHERE t.id = p_tenant_id
       AND t.status = 'DELETING'
       AND d.state = 'RUNNING'
  );
$$;

CREATE OR REPLACE FUNCTION reproforge_reject_append_only_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE'
     AND TG_TABLE_NAME IN ('run_evidence', 'audit_events')
     AND reproforge_retention_purge_allowed(OLD.tenant_id) THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME
    USING ERRCODE = '55000';
END;
$$;
