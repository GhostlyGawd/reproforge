CREATE TABLE tenant_restore_sessions (
  tenant_id text PRIMARY KEY,
  backup_sha256 char(64) NOT NULL,
  requested_by text NOT NULL,
  manifest_schema_version text NOT NULL,
  state text NOT NULL DEFAULT 'RUNNING',
  case_count integer NOT NULL,
  evidence_count integer NOT NULL,
  artifact_count integer NOT NULL,
  byte_count bigint NOT NULL,
  started_at timestamptz NOT NULL,
  completed_at timestamptz,
  verified_at timestamptz,
  CONSTRAINT tenant_restore_sessions_tenant_fk
    FOREIGN KEY (tenant_id) REFERENCES tenants (id) ON DELETE RESTRICT,
  CONSTRAINT tenant_restore_sessions_hash_format
    CHECK (backup_sha256 ~ '^[a-f0-9]{64}$'),
  CONSTRAINT tenant_restore_sessions_requester_format
    CHECK (requested_by ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
  CONSTRAINT tenant_restore_sessions_schema_version
    CHECK (manifest_schema_version = '1.0'),
  CONSTRAINT tenant_restore_sessions_state
    CHECK (state IN ('RUNNING', 'RESTORED', 'VERIFIED')),
  CONSTRAINT tenant_restore_sessions_counts
    CHECK (
      case_count >= 0 AND evidence_count >= 0
      AND artifact_count >= 0 AND byte_count >= 0
    ),
  CONSTRAINT tenant_restore_sessions_completion_shape
    CHECK (
      (state = 'RUNNING' AND completed_at IS NULL AND verified_at IS NULL)
      OR
      (state = 'RESTORED' AND completed_at IS NOT NULL AND verified_at IS NULL)
      OR
      (state = 'VERIFIED' AND completed_at IS NOT NULL
        AND verified_at IS NOT NULL AND verified_at >= completed_at)
    )
);

CREATE INDEX tenant_restore_sessions_state_idx
  ON tenant_restore_sessions (state, started_at);

CREATE OR REPLACE FUNCTION reproforge_require_evidence_lease()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM tenant_restore_sessions
     WHERE tenant_id = NEW.tenant_id AND state = 'RUNNING'
  ) THEN
    RETURN NEW;
  END IF;
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
