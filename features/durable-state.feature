Feature: Durable reproduction state
  ReproForge must make idempotency and tenant boundaries authoritative in
  Postgres rather than relying on one application process.

  Scenario: A durable reproduction survives an application adapter restart
    Given an empty durable Postgres store for a tenant
    When the caller reserves a durable reproduction
    And the application repository adapter is recreated
    Then the durable case and job remain readable

  Scenario: An idempotent retry after a restart returns the original case
    Given an empty durable Postgres store for a tenant
    When the caller reserves a durable reproduction
    And the application repository adapter is recreated
    And the caller retries the same durable start
    Then exactly one durable case and job exist
    And the retry returns the original durable case and job

  Scenario: A trusted reproduction survives a complete durable service restart
    Given an empty durable Postgres store for a tenant
    When the caller runs the trusted fixture through the durable service
    And the durable trusted service is recreated
    And the caller retries the trusted fixture through the durable service
    Then the verified case job and bundle identities are unchanged
    And exactly one identifier-only provider message was published
    And exactly one private verified bundle is durable

  Scenario: Conflicting use of an idempotency key is rejected
    Given an empty durable Postgres store for a tenant
    When the caller reserves a durable reproduction
    And the caller retries the durable key with changed input
    Then the durable start error code is "IDEMPOTENCY_CONFLICT"
    And exactly one durable case and job exist

  Scenario: A tenant cannot read another tenant's case
    Given an empty durable Postgres store for a tenant
    When the caller reserves a durable reproduction
    And another tenant reads the durable case
    Then the cross-tenant durable read returns not found

  Scenario: A tenant cannot read another tenant's private artifact
    Given an empty durable Postgres store for a tenant
    And a private bundle artifact for the durable case
    When another tenant reads the private artifact
    Then the cross-tenant artifact read returns not found before provider access

  Scenario: Deleting a private artifact removes all later access
    Given an empty durable Postgres store for a tenant
    And a private bundle artifact for the durable case
    When the owner deletes the private artifact
    Then the private artifact is no longer readable

  Scenario: A duplicate queue delivery performs no duplicate work
    Given an empty durable Postgres store for a tenant
    When the caller reserves a durable reproduction
    And the same queued job is delivered twice
    Then exactly one durable attempt completes

  Scenario: An expired worker lease is recovered once
    Given an empty durable Postgres store for a tenant
    When the caller reserves a durable reproduction
    And a worker lease expires and recovery runs twice
    Then exactly one recovery intent requeues the durable job

  Scenario: A cancelled queued job never starts
    Given an empty durable Postgres store for a tenant
    When the caller reserves a durable reproduction
    And the caller cancels the queued durable job
    And the cancelled durable job is delivered
    Then no durable attempt starts

  Scenario: Retention deletion removes customer artifacts and records an audit tombstone
    Given an expired tenant with a private durable artifact
    When the retention deletion worker runs
    Then all retained customer data is removed
    And exactly one sanitized deletion audit tombstone remains

  Scenario: Missing production configuration fails readiness without falling back
    Given a hosted runtime with incomplete production configuration
    When dependency readiness is checked
    Then readiness fails with "INVALID_RUNTIME_CONFIGURATION"
    And no local provider fallback is reported

  Scenario: A verified bundle is readable after restore
    Given a verified tenant backup with a private bundle
    When the tenant backup is restored into an empty durable store
    Then the restored durable case and evidence match the backup
    And the verified private bundle is readable after restore
