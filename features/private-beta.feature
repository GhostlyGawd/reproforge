Feature: Private-beta ReproForge
  The hosted product must expose one durable truth across every user surface.

  Scenario: The same case is visible consistently in ChatGPT and the web app
    Given a durable private-beta case is experimenting
    When REST, MCP, widget, and web progress views are projected
    Then every product surface reports the same durable progress

  Scenario: A signed-in user starts an authorized repository from the web
    Given a signed-in authorized repository web form
    When the user submits an exact same-origin failure contract
    Then one repository command is accepted and the web redirects to durable progress

  Scenario: GitHub connection stays available while execution dependencies are degraded
    Given a signed-in GitHub authorization surface with failed execution composition
    When the user starts the isolated GitHub App authorization
    Then the browser redirects to GitHub without reinitializing execution dependencies

  Scenario: A GitHub login establishes a stable tenant without a custom ID-token claim
    Given a validated GitHub web session without a tenant claim
    When ReproForge resolves the signed-in web identity
    Then the web identity uses the deterministic tenant ID

  Scenario: A worker loss recovers an expired lease
    Given an empty durable Postgres store for a tenant
    When the caller reserves a durable reproduction
    And a worker lease expires and recovery runs twice
    Then exactly one recovery intent requeues the durable job
    And exactly one sanitized lease recovery audit is durable

  Scenario: Restart and duplicate delivery preserve one durable outcome
    Given an active private-beta job survives adapter reconstruction
    When the same durable queue message is delivered twice
    Then exactly one worker execution reaches one terminal job

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

  Scenario: A kill switch blocks new starts without hiding existing evidence
    Given a completed private-beta repository case and the global start kill switch
    When the user reads the completed case and attempts a kill-switched repository start
    Then the completed case remains readable during the start kill switch
    And the new start is denied with a sanitized feature-policy audit

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
