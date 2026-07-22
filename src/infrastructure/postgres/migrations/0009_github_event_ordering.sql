ALTER TABLE github_installations
  ADD COLUMN provider_updated_at timestamptz;

ALTER TABLE github_repositories
  ADD COLUMN provider_updated_at timestamptz;

CREATE INDEX github_installations_provider_updated_idx
  ON github_installations (installation_id, provider_updated_at DESC);

CREATE INDEX github_repositories_provider_updated_idx
  ON github_repositories (provider_repository_id, provider_updated_at DESC);
