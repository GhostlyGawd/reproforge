Feature: Private-beta ReproForge
  The hosted product must expose one durable truth across every user surface.

  Scenario: The same case is visible consistently in ChatGPT and the web app
    Given a durable private-beta case is experimenting
    When REST, MCP, widget, and web progress views are projected
    Then every product surface reports the same durable progress

  Scenario: A worker loss recovers an expired lease
    Given an empty durable Postgres store for a tenant
    When the caller reserves a durable reproduction
    And a worker lease expires and recovery runs twice
    Then exactly one recovery intent requeues the durable job
    And exactly one sanitized lease recovery audit is durable

  Scenario: A user cancels an active repository job
    Given an active cancellable repository experiment
    When the repository experiment is cancelled
    Then the repository error code is "CANCELLED"
    And every allocated sandbox resource is cleaned

  Scenario: Runner degradation blocks new starts while completed cases remain readable
    Given a completed private-beta repository case and a degraded runner
    When the user reads the completed case and attempts a new repository start
    Then the completed case remains readable during runner degradation
    And the new start is denied with a sanitized runner audit

  Scenario: An operator safely resolves a quarantined sandbox
    Given an audited private-beta sandbox quarantine
    When the operator resolves the exact sandbox twice
    Then the quarantined sandbox is deleted exactly once
    And the quarantine resolution is audited and no longer open

  Scenario: A user exports then deletes retained case data
    Given a signed-in private-beta tenant with a retained verified case
    When the user exports the account and confirms deletion
    Then the portable export preserves the verified private bundle
    And the tenant data is deleted with only a sanitized tombstone
