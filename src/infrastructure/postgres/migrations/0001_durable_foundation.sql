CREATE TABLE tenants (
  id text PRIMARY KEY,
  status text NOT NULL DEFAULT 'ACTIVE',
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  deleted_at timestamptz,
  retention_until timestamptz,
  CONSTRAINT tenants_id_format
    CHECK (id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
  CONSTRAINT tenants_status_valid
    CHECK (status IN ('ACTIVE', 'SUSPENDED', 'DELETING', 'DELETED')),
  CONSTRAINT tenants_timestamp_order
    CHECK (updated_at >= created_at),
  CONSTRAINT tenants_deleted_state
    CHECK (deleted_at IS NULL OR status = 'DELETED'),
  CONSTRAINT tenants_retention_order
    CHECK (retention_until IS NULL OR retention_until > created_at)
);

CREATE INDEX tenants_retention_idx
  ON tenants (retention_until)
  WHERE retention_until IS NOT NULL;

CREATE TABLE principals (
  tenant_id text NOT NULL,
  id text NOT NULL,
  provider text NOT NULL,
  issuer text NOT NULL,
  external_subject text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_seen_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  retention_until timestamptz NOT NULL DEFAULT (CURRENT_TIMESTAMP + interval '365 days'),
  PRIMARY KEY (tenant_id, id),
  CONSTRAINT principals_tenant_fk
    FOREIGN KEY (tenant_id) REFERENCES tenants (id) ON DELETE RESTRICT,
  CONSTRAINT principals_id_format
    CHECK (id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
  CONSTRAINT principals_provider_format
    CHECK (provider ~ '^[a-z][a-z0-9-]{0,31}$'),
  CONSTRAINT principals_issuer_nonempty CHECK (length(issuer) BETWEEN 1 AND 512),
  CONSTRAINT principals_subject_nonempty
    CHECK (length(external_subject) BETWEEN 1 AND 512),
  CONSTRAINT principals_timestamp_order
    CHECK (
      updated_at >= created_at AND last_seen_at >= created_at
      AND retention_until > created_at
    )
);

CREATE UNIQUE INDEX principals_external_subject_idx
  ON principals (issuer, external_subject);

CREATE INDEX principals_retention_idx
  ON principals (retention_until, tenant_id);

CREATE TABLE cases (
  tenant_id text NOT NULL,
  id text NOT NULL,
  source_kind text NOT NULL,
  source_descriptor jsonb NOT NULL,
  state text NOT NULL DEFAULT 'DRAFT',
  domain_state jsonb NOT NULL DEFAULT '{}'::jsonb,
  schema_version text NOT NULL DEFAULT '1.0',
  version bigint NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  retention_until timestamptz NOT NULL DEFAULT (CURRENT_TIMESTAMP + interval '30 days'),
  deleted_at timestamptz,
  PRIMARY KEY (tenant_id, id),
  CONSTRAINT cases_tenant_fk
    FOREIGN KEY (tenant_id) REFERENCES tenants (id) ON DELETE RESTRICT,
  CONSTRAINT cases_id_format
    CHECK (id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
  CONSTRAINT cases_source_kind_valid
    CHECK (source_kind IN ('trusted-sample', 'github')),
  CONSTRAINT cases_source_descriptor_object
    CHECK (jsonb_typeof(source_descriptor) = 'object'),
  CONSTRAINT cases_state_valid
    CHECK (state IN (
      'DRAFT', 'INGESTING', 'INSPECTING', 'HYPOTHESIZING', 'EXPERIMENTING',
      'VERIFYING', 'MINIMIZING', 'PACKAGING', 'VERIFIED', 'UNSTABLE',
      'NOT_REPRODUCED', 'BLOCKED', 'CANCELLED'
    )),
  CONSTRAINT cases_domain_state_object
    CHECK (jsonb_typeof(domain_state) = 'object'),
  CONSTRAINT cases_schema_version_format
    CHECK (schema_version ~ '^[0-9]+\.[0-9]+$'),
  CONSTRAINT cases_version_positive CHECK (version >= 1),
  CONSTRAINT cases_timestamp_order
    CHECK (updated_at >= created_at AND retention_until > created_at),
  CONSTRAINT cases_deleted_timestamp
    CHECK (deleted_at IS NULL OR deleted_at >= created_at)
);

CREATE INDEX cases_tenant_state_idx
  ON cases (tenant_id, state, updated_at DESC);

CREATE INDEX cases_retention_idx
  ON cases (retention_until, tenant_id)
  WHERE deleted_at IS NULL;

CREATE TABLE jobs (
  tenant_id text NOT NULL,
  id text NOT NULL,
  case_id text NOT NULL,
  state text NOT NULL DEFAULT 'QUEUED',
  progress_phase text NOT NULL DEFAULT 'DRAFT',
  attempt integer NOT NULL DEFAULT 0,
  max_attempts integer NOT NULL DEFAULT 3,
  next_attempt_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  lease_owner text,
  lease_acquired_at timestamptz,
  lease_expires_at timestamptz,
  cancellation_requested_at timestamptz,
  cancelled_at timestamptz,
  failure_code text,
  failure_message text,
  failure_retryable boolean,
  version bigint NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  retention_until timestamptz NOT NULL DEFAULT (CURRENT_TIMESTAMP + interval '30 days'),
  PRIMARY KEY (tenant_id, id),
  CONSTRAINT jobs_tenant_case_id_unique UNIQUE (tenant_id, case_id, id),
  CONSTRAINT jobs_case_fk
    FOREIGN KEY (tenant_id, case_id) REFERENCES cases (tenant_id, id)
      ON DELETE RESTRICT,
  CONSTRAINT jobs_id_format
    CHECK (id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
  CONSTRAINT jobs_state_valid
    CHECK (state IN ('QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELLED')),
  CONSTRAINT jobs_progress_phase_valid
    CHECK (progress_phase IN (
      'DRAFT', 'INGESTING', 'INSPECTING', 'HYPOTHESIZING', 'EXPERIMENTING',
      'VERIFYING', 'MINIMIZING', 'PACKAGING', 'VERIFIED', 'UNSTABLE',
      'NOT_REPRODUCED', 'BLOCKED', 'CANCELLED'
    )),
  CONSTRAINT jobs_attempt_bounds
    CHECK (attempt >= 0 AND max_attempts > 0 AND attempt <= max_attempts),
  CONSTRAINT jobs_lease_complete
    CHECK (
      (lease_owner IS NULL AND lease_acquired_at IS NULL AND lease_expires_at IS NULL)
      OR
      (lease_owner IS NOT NULL AND lease_acquired_at IS NOT NULL
        AND lease_expires_at IS NOT NULL AND lease_expires_at > lease_acquired_at)
    ),
  CONSTRAINT jobs_cancelled_state
    CHECK (cancelled_at IS NULL OR state = 'CANCELLED'),
  CONSTRAINT jobs_failure_shape
    CHECK (
      (state = 'FAILED' AND failure_code IS NOT NULL AND failure_message IS NOT NULL
        AND failure_retryable IS NOT NULL)
      OR
      (state <> 'FAILED' AND failure_code IS NULL AND failure_message IS NULL
        AND failure_retryable IS NULL)
    ),
  CONSTRAINT jobs_version_positive CHECK (version >= 1),
  CONSTRAINT jobs_timestamp_order
    CHECK (
      updated_at >= created_at AND retention_until > created_at
      AND (cancellation_requested_at IS NULL OR cancellation_requested_at >= created_at)
      AND (cancelled_at IS NULL OR cancelled_at >= created_at)
    )
);

CREATE INDEX jobs_tenant_state_next_attempt_idx
  ON jobs (tenant_id, state, next_attempt_at, created_at);

CREATE INDEX jobs_expired_lease_idx
  ON jobs (lease_expires_at)
  WHERE state = 'RUNNING' AND lease_expires_at IS NOT NULL;

CREATE INDEX jobs_retention_idx
  ON jobs (retention_until, tenant_id);

CREATE TABLE idempotency_keys (
  tenant_id text NOT NULL,
  caller_id text NOT NULL,
  idempotency_key text NOT NULL,
  command_hash char(64) NOT NULL,
  case_id text NOT NULL,
  job_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at timestamptz NOT NULL DEFAULT (CURRENT_TIMESTAMP + interval '30 days'),
  PRIMARY KEY (tenant_id, caller_id, idempotency_key),
  CONSTRAINT idempotency_result_fk
    FOREIGN KEY (tenant_id, case_id, job_id)
      REFERENCES jobs (tenant_id, case_id, id) ON DELETE RESTRICT,
  CONSTRAINT idempotency_caller_format
    CHECK (caller_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
  CONSTRAINT idempotency_key_length
    CHECK (length(idempotency_key) BETWEEN 1 AND 128),
  CONSTRAINT idempotency_command_hash_format
    CHECK (command_hash ~ '^[a-f0-9]{64}$'),
  CONSTRAINT idempotency_expiry_order CHECK (expires_at > created_at)
);

CREATE INDEX idempotency_expiry_idx
  ON idempotency_keys (expires_at, tenant_id);

CREATE TABLE run_evidence (
  tenant_id text NOT NULL,
  case_id text NOT NULL,
  job_id text NOT NULL,
  attempt integer NOT NULL,
  sequence integer NOT NULL,
  kind text NOT NULL,
  command_hash char(64),
  exit_code integer,
  passed boolean,
  duration_ms bigint,
  environment jsonb NOT NULL,
  evidence jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  retention_until timestamptz NOT NULL DEFAULT (CURRENT_TIMESTAMP + interval '30 days'),
  PRIMARY KEY (tenant_id, job_id, attempt, sequence),
  CONSTRAINT run_evidence_job_fk
    FOREIGN KEY (tenant_id, case_id, job_id)
      REFERENCES jobs (tenant_id, case_id, id) ON DELETE RESTRICT,
  CONSTRAINT run_evidence_attempt_sequence_positive
    CHECK (attempt >= 1 AND sequence >= 1),
  CONSTRAINT run_evidence_kind_valid
    CHECK (kind IN (
      'positive-control', 'negative-control', 'environment', 'observation', 'output'
    )),
  CONSTRAINT run_evidence_command_hash_format
    CHECK (command_hash IS NULL OR command_hash ~ '^[a-f0-9]{64}$'),
  CONSTRAINT run_evidence_duration_nonnegative
    CHECK (duration_ms IS NULL OR duration_ms >= 0),
  CONSTRAINT run_evidence_environment_object
    CHECK (jsonb_typeof(environment) = 'object'),
  CONSTRAINT run_evidence_body_object
    CHECK (jsonb_typeof(evidence) = 'object'),
  CONSTRAINT run_evidence_retention_order CHECK (retention_until > created_at)
);

CREATE INDEX run_evidence_job_idx
  ON run_evidence (tenant_id, job_id, attempt, sequence);

CREATE INDEX run_evidence_retention_idx
  ON run_evidence (retention_until, tenant_id);

CREATE TABLE artifacts (
  tenant_id text NOT NULL,
  id text NOT NULL,
  case_id text NOT NULL,
  kind text NOT NULL,
  sha256 char(64) NOT NULL,
  byte_count bigint NOT NULL,
  object_key text NOT NULL,
  access_class text NOT NULL DEFAULT 'PRIVATE',
  retention_class text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  retention_until timestamptz NOT NULL,
  deleted_at timestamptz,
  PRIMARY KEY (tenant_id, id),
  CONSTRAINT artifacts_content_identity_unique
    UNIQUE (tenant_id, case_id, kind, sha256),
  CONSTRAINT artifacts_object_key_unique UNIQUE (object_key),
  CONSTRAINT artifacts_case_fk
    FOREIGN KEY (tenant_id, case_id) REFERENCES cases (tenant_id, id)
      ON DELETE RESTRICT,
  CONSTRAINT artifacts_id_format
    CHECK (id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
  CONSTRAINT artifacts_kind_valid
    CHECK (kind IN ('source', 'run-log', 'run-output', 'bundle', 'backup-manifest')),
  CONSTRAINT artifacts_hash_format CHECK (sha256 ~ '^[a-f0-9]{64}$'),
  CONSTRAINT artifacts_byte_count_nonnegative CHECK (byte_count >= 0),
  CONSTRAINT artifacts_private_only CHECK (access_class = 'PRIVATE'),
  CONSTRAINT artifacts_retention_class_valid
    CHECK (retention_class IN ('source', 'run', 'bundle', 'backup')),
  CONSTRAINT artifacts_object_key_content_addressed
    CHECK (
      object_key = 'tenants/' || tenant_id || '/cases/' || case_id || '/' || kind || '/' || sha256
    ),
  CONSTRAINT artifacts_retention_order
    CHECK (
      retention_until > created_at
      AND (deleted_at IS NULL OR deleted_at >= created_at)
    )
);

CREATE INDEX artifacts_retention_idx
  ON artifacts (retention_until, tenant_id)
  WHERE deleted_at IS NULL;

CREATE TABLE outbox_events (
  tenant_id text NOT NULL,
  id text NOT NULL,
  case_id text NOT NULL,
  job_id text NOT NULL,
  kind text NOT NULL,
  schema_version text NOT NULL DEFAULT '1.0',
  payload jsonb NOT NULL,
  status text NOT NULL DEFAULT 'PENDING',
  delivery_count integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  delivered_at timestamptz,
  last_error_code text,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  retention_until timestamptz NOT NULL DEFAULT (CURRENT_TIMESTAMP + interval '30 days'),
  PRIMARY KEY (tenant_id, id),
  CONSTRAINT outbox_job_fk
    FOREIGN KEY (tenant_id, case_id, job_id)
      REFERENCES jobs (tenant_id, case_id, id) ON DELETE RESTRICT,
  CONSTRAINT outbox_id_format
    CHECK (id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
  CONSTRAINT outbox_kind_valid
    CHECK (kind IN (
      'reproduction.requested', 'reproduction.cancelled',
      'reproduction.recovery-requested', 'retention.deletion-requested'
    )),
  CONSTRAINT outbox_schema_version_valid CHECK (schema_version = '1.0'),
  CONSTRAINT outbox_payload_object CHECK (jsonb_typeof(payload) = 'object'),
  CONSTRAINT outbox_payload_identifier_only
    CHECK (
      payload ?& ARRAY[
        'caseId', 'eventId', 'jobId', 'kind', 'schemaVersion', 'tenantId'
      ]::text[]
      AND payload - ARRAY[
        'caseId', 'eventId', 'jobId', 'kind', 'schemaVersion', 'tenantId'
      ]::text[] = '{}'::jsonb
      AND payload->>'caseId' = case_id
      AND payload->>'eventId' = id
      AND payload->>'jobId' = job_id
      AND payload->>'kind' = kind
      AND payload->>'schemaVersion' = schema_version
      AND payload->>'tenantId' = tenant_id
    ),
  CONSTRAINT outbox_status_valid
    CHECK (status IN ('PENDING', 'DELIVERED', 'DEAD')),
  CONSTRAINT outbox_delivery_count_nonnegative CHECK (delivery_count >= 0),
  CONSTRAINT outbox_delivery_state
    CHECK (
      (status = 'DELIVERED' AND delivered_at IS NOT NULL)
      OR (status <> 'DELIVERED' AND delivered_at IS NULL)
    ),
  CONSTRAINT outbox_error_code_length
    CHECK (last_error_code IS NULL OR length(last_error_code) BETWEEN 1 AND 96),
  CONSTRAINT outbox_retention_order CHECK (retention_until > created_at)
);

CREATE INDEX outbox_pending_idx
  ON outbox_events (next_attempt_at, created_at)
  WHERE status = 'PENDING';

CREATE INDEX outbox_retention_idx
  ON outbox_events (retention_until, tenant_id);

CREATE TABLE audit_events (
  tenant_id text NOT NULL,
  id text NOT NULL,
  actor_id text NOT NULL,
  action text NOT NULL,
  target_type text NOT NULL,
  target_id text NOT NULL,
  outcome text NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  retention_until timestamptz NOT NULL DEFAULT (CURRENT_TIMESTAMP + interval '365 days'),
  PRIMARY KEY (tenant_id, id),
  CONSTRAINT audit_tenant_fk
    FOREIGN KEY (tenant_id) REFERENCES tenants (id) ON DELETE RESTRICT,
  CONSTRAINT audit_id_actor_target_format
    CHECK (
      id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
      AND actor_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
      AND target_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
    ),
  CONSTRAINT audit_action_format CHECK (action ~ '^[a-z][a-z0-9.-]{0,95}$'),
  CONSTRAINT audit_target_type_valid
    CHECK (target_type IN (
      'account', 'artifact', 'case', 'installation', 'job', 'repository'
    )),
  CONSTRAINT audit_outcome_valid CHECK (outcome IN ('success', 'denied', 'failure')),
  CONSTRAINT audit_metadata_object CHECK (jsonb_typeof(metadata) = 'object'),
  CONSTRAINT audit_metadata_size CHECK (octet_length(metadata::text) <= 8192),
  CONSTRAINT audit_retention_order CHECK (retention_until > occurred_at)
);

CREATE INDEX audit_tenant_occurred_idx
  ON audit_events (tenant_id, occurred_at DESC, id);

CREATE INDEX audit_retention_idx
  ON audit_events (retention_until, tenant_id);

CREATE TABLE quota_ledger (
  tenant_id text NOT NULL,
  id text NOT NULL,
  resource text NOT NULL,
  window_start timestamptz NOT NULL,
  window_end timestamptz NOT NULL,
  reserved_amount bigint NOT NULL,
  actual_amount bigint NOT NULL DEFAULT 0,
  state text NOT NULL DEFAULT 'RESERVED',
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  retention_until timestamptz NOT NULL DEFAULT (CURRENT_TIMESTAMP + interval '365 days'),
  PRIMARY KEY (tenant_id, id),
  CONSTRAINT quota_tenant_fk
    FOREIGN KEY (tenant_id) REFERENCES tenants (id) ON DELETE RESTRICT,
  CONSTRAINT quota_id_format
    CHECK (id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
  CONSTRAINT quota_resource_valid
    CHECK (resource IN ('active-jobs', 'artifact-bytes', 'cpu-milliseconds', 'exports')),
  CONSTRAINT quota_window_order
    CHECK (window_end > window_start),
  CONSTRAINT quota_amount_bounds
    CHECK (
      reserved_amount > 0 AND actual_amount >= 0 AND actual_amount <= reserved_amount
    ),
  CONSTRAINT quota_state_valid
    CHECK (state IN ('RESERVED', 'COMMITTED', 'RELEASED', 'EXPIRED')),
  CONSTRAINT quota_expiry_order CHECK (expires_at > created_at),
  CONSTRAINT quota_timestamp_order
    CHECK (updated_at >= created_at AND retention_until > created_at)
);

CREATE INDEX quota_tenant_window_idx
  ON quota_ledger (tenant_id, resource, window_start, window_end, state);

CREATE INDEX quota_retention_idx
  ON quota_ledger (retention_until, tenant_id);

CREATE TABLE deletion_requests (
  tenant_id text NOT NULL,
  id text NOT NULL,
  requested_by text NOT NULL,
  state text NOT NULL DEFAULT 'REQUESTED',
  scheduled_at timestamptz,
  completed_at timestamptz,
  class_results jsonb NOT NULL DEFAULT '{}'::jsonb,
  audit_tombstone_id text,
  failure_code text,
  version bigint NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  retention_until timestamptz NOT NULL DEFAULT (CURRENT_TIMESTAMP + interval '365 days'),
  PRIMARY KEY (tenant_id, id),
  CONSTRAINT deletion_tenant_fk
    FOREIGN KEY (tenant_id) REFERENCES tenants (id) ON DELETE RESTRICT,
  CONSTRAINT deletion_id_requester_format
    CHECK (
      id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
      AND requested_by ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
    ),
  CONSTRAINT deletion_state_valid
    CHECK (state IN ('REQUESTED', 'SCHEDULED', 'RUNNING', 'COMPLETED', 'FAILED')),
  CONSTRAINT deletion_results_object CHECK (jsonb_typeof(class_results) = 'object'),
  CONSTRAINT deletion_version_positive CHECK (version >= 1),
  CONSTRAINT deletion_timestamp_order
    CHECK (
      updated_at >= created_at
      AND retention_until > created_at
      AND (scheduled_at IS NULL OR scheduled_at >= created_at)
      AND (completed_at IS NULL OR completed_at >= created_at)
    ),
  CONSTRAINT deletion_completion_shape
    CHECK (
      (state = 'COMPLETED' AND completed_at IS NOT NULL AND audit_tombstone_id IS NOT NULL)
      OR (state <> 'COMPLETED' AND completed_at IS NULL)
    ),
  CONSTRAINT deletion_failure_shape
    CHECK (
      (state = 'FAILED' AND failure_code IS NOT NULL)
      OR (state <> 'FAILED' AND failure_code IS NULL)
    )
);

CREATE INDEX deletion_schedule_idx
  ON deletion_requests (scheduled_at, created_at)
  WHERE state IN ('REQUESTED', 'SCHEDULED');

CREATE INDEX deletion_retention_idx
  ON deletion_requests (retention_until, tenant_id);
