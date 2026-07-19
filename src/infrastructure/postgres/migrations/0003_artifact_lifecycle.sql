ALTER TABLE artifacts
  ADD COLUMN status text NOT NULL DEFAULT 'PENDING',
  ADD COLUMN provider_etag text,
  ADD COLUMN verified_at timestamptz,
  ADD COLUMN failure_code text,
  ADD COLUMN version bigint NOT NULL DEFAULT 1,
  ADD COLUMN updated_at timestamptz;

UPDATE artifacts SET updated_at = created_at WHERE updated_at IS NULL;

ALTER TABLE artifacts
  ALTER COLUMN updated_at SET NOT NULL,
  ADD CONSTRAINT artifacts_status_valid
    CHECK (status IN ('PENDING', 'AVAILABLE', 'DELETING', 'DELETED', 'FAILED')),
  ADD CONSTRAINT artifacts_provider_etag_length
    CHECK (provider_etag IS NULL OR length(provider_etag) BETWEEN 1 AND 512),
  ADD CONSTRAINT artifacts_failure_code_length
    CHECK (failure_code IS NULL OR length(failure_code) BETWEEN 1 AND 96),
  ADD CONSTRAINT artifacts_version_positive CHECK (version >= 1),
  ADD CONSTRAINT artifacts_updated_timestamp_order
    CHECK (updated_at >= created_at),
  ADD CONSTRAINT artifacts_lifecycle_shape
    CHECK (
      (status = 'PENDING' AND provider_etag IS NULL AND verified_at IS NULL
        AND failure_code IS NULL AND deleted_at IS NULL)
      OR
      (status = 'AVAILABLE' AND provider_etag IS NOT NULL AND verified_at IS NOT NULL
        AND failure_code IS NULL AND deleted_at IS NULL)
      OR
      (status = 'DELETING' AND provider_etag IS NOT NULL AND verified_at IS NOT NULL
        AND failure_code IS NULL AND deleted_at IS NULL)
      OR
      (status = 'DELETED' AND provider_etag IS NOT NULL AND verified_at IS NOT NULL
        AND failure_code IS NULL AND deleted_at IS NOT NULL)
      OR
      (status = 'FAILED' AND provider_etag IS NULL AND verified_at IS NULL
        AND failure_code IS NOT NULL AND deleted_at IS NULL)
    );

CREATE TRIGGER artifacts_successor_version
BEFORE UPDATE ON artifacts
FOR EACH ROW EXECUTE FUNCTION reproforge_enforce_successor_version();

CREATE INDEX artifacts_status_idx
  ON artifacts (tenant_id, status, updated_at);
