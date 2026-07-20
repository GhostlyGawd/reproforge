CREATE TABLE github_webhook_deliveries (
  delivery_id text PRIMARY KEY,
  event text NOT NULL,
  payload_hash char(64) NOT NULL,
  tenant_id text,
  installation_id bigint,
  action text,
  outcome text NOT NULL DEFAULT 'PROCESSING',
  received_at timestamptz NOT NULL,
  processed_at timestamptz,
  expires_at timestamptz NOT NULL,
  CONSTRAINT github_webhook_deliveries_tenant_fk
    FOREIGN KEY (tenant_id) REFERENCES tenants (id) ON DELETE SET NULL,
  CONSTRAINT github_webhook_deliveries_id_format
    CHECK (delivery_id ~ '^[A-Za-z0-9-]{1,128}$'),
  CONSTRAINT github_webhook_deliveries_event_valid
    CHECK (event IN ('installation', 'installation_repositories')),
  CONSTRAINT github_webhook_deliveries_hash_format
    CHECK (payload_hash ~ '^[a-f0-9]{64}$'),
  CONSTRAINT github_webhook_deliveries_installation_positive
    CHECK (installation_id IS NULL OR installation_id > 0),
  CONSTRAINT github_webhook_deliveries_action_format
    CHECK (action IS NULL OR action ~ '^[a-z_]{1,64}$'),
  CONSTRAINT github_webhook_deliveries_outcome_valid
    CHECK (outcome IN ('PROCESSING', 'ACCEPTED', 'IGNORED')),
  CONSTRAINT github_webhook_deliveries_timestamp_order
    CHECK (
      expires_at > received_at
      AND (processed_at IS NULL OR processed_at >= received_at)
      AND (outcome = 'PROCESSING' OR processed_at IS NOT NULL)
    )
);

CREATE INDEX github_webhook_deliveries_expiry_idx
  ON github_webhook_deliveries (expires_at);

CREATE INDEX github_webhook_deliveries_installation_idx
  ON github_webhook_deliveries (installation_id, received_at DESC)
  WHERE installation_id IS NOT NULL;
