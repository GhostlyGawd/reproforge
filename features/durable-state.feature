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
