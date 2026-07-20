CREATE TABLE github_installation_states (
  state_hash char(64) PRIMARY KEY,
  tenant_id text NOT NULL,
  principal_id text NOT NULL,
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  CONSTRAINT github_installation_states_principal_fk
    FOREIGN KEY (tenant_id, principal_id)
      REFERENCES principals (tenant_id, id) ON DELETE CASCADE,
  CONSTRAINT github_installation_states_hash_format
    CHECK (state_hash ~ '^[a-f0-9]{64}$'),
  CONSTRAINT github_installation_states_timestamp_order
    CHECK (
      expires_at > created_at
      AND (consumed_at IS NULL OR consumed_at >= created_at)
    )
);

CREATE INDEX github_installation_states_expiry_idx
  ON github_installation_states (expires_at)
  WHERE consumed_at IS NULL;

CREATE TABLE github_installations (
  tenant_id text NOT NULL,
  installation_id bigint NOT NULL,
  linked_by_principal_id text NOT NULL,
  account_id bigint NOT NULL,
  account_login text NOT NULL,
  repository_selection text NOT NULL,
  permissions jsonb NOT NULL,
  status text NOT NULL DEFAULT 'ACTIVE',
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  suspended_at timestamptz,
  removed_at timestamptz,
  PRIMARY KEY (tenant_id, installation_id),
  CONSTRAINT github_installations_global_id_unique UNIQUE (installation_id),
  CONSTRAINT github_installations_principal_fk
    FOREIGN KEY (tenant_id, linked_by_principal_id)
      REFERENCES principals (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT github_installations_numeric_ids
    CHECK (installation_id > 0 AND account_id > 0),
  CONSTRAINT github_installations_account_login_format
    CHECK (account_login ~ '^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$'),
  CONSTRAINT github_installations_selection_valid
    CHECK (repository_selection IN ('all', 'selected')),
  CONSTRAINT github_installations_permissions_exact
    CHECK (
      permissions = '{"contents":"read","issues":"read","metadata":"read"}'::jsonb
    ),
  CONSTRAINT github_installations_status_valid
    CHECK (status IN ('ACTIVE', 'SUSPENDED', 'REMOVED')),
  CONSTRAINT github_installations_status_timestamps
    CHECK (
      (status <> 'SUSPENDED' OR suspended_at IS NOT NULL)
      AND (status <> 'REMOVED' OR removed_at IS NOT NULL)
      AND updated_at >= created_at
    )
);

CREATE INDEX github_installations_tenant_status_idx
  ON github_installations (tenant_id, status, updated_at DESC);

CREATE TABLE github_repositories (
  tenant_id text NOT NULL,
  repository_id text NOT NULL,
  installation_id bigint NOT NULL,
  provider_repository_id bigint NOT NULL,
  full_name text NOT NULL,
  default_branch text NOT NULL,
  is_private boolean NOT NULL,
  status text NOT NULL DEFAULT 'ACTIVE',
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  removed_at timestamptz,
  PRIMARY KEY (tenant_id, repository_id),
  CONSTRAINT github_repositories_provider_id_unique
    UNIQUE (provider_repository_id),
  CONSTRAINT github_repositories_installation_provider_unique
    UNIQUE (tenant_id, installation_id, provider_repository_id),
  CONSTRAINT github_repositories_installation_fk
    FOREIGN KEY (tenant_id, installation_id)
      REFERENCES github_installations (tenant_id, installation_id)
      ON DELETE CASCADE,
  CONSTRAINT github_repositories_id_format
    CHECK (repository_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
  CONSTRAINT github_repositories_provider_id_positive
    CHECK (provider_repository_id > 0),
  CONSTRAINT github_repositories_full_name_format
    CHECK (
      length(full_name) BETWEEN 3 AND 255
      AND full_name ~ '^[^/[:space:]]+/[^/[:space:]]+$'
    ),
  CONSTRAINT github_repositories_default_branch_valid
    CHECK (
      length(default_branch) BETWEEN 1 AND 255
      AND default_branch !~ '[[:cntrl:]]'
    ),
  CONSTRAINT github_repositories_status_valid
    CHECK (status IN ('ACTIVE', 'REMOVED')),
  CONSTRAINT github_repositories_status_timestamps
    CHECK (
      (status <> 'REMOVED' OR removed_at IS NOT NULL)
      AND updated_at >= created_at
    )
);

CREATE INDEX github_repositories_tenant_active_idx
  ON github_repositories (tenant_id, repository_id)
  WHERE status = 'ACTIVE';
