Feature: Evidence-backed reproduction outcomes
  ReproForge must derive terminal outcomes from an oracle and captured runs,
  never from investigator confidence.

  Scenario: A deterministic failure is verified
    Given a failure oracle that expects exit code 1
    And a negative control that exits with code 0
    And 3 candidate runs that exit with code 1
    When the reproduction is verified
    Then the outcome is "VERIFIED"
    And repeatability is 100 percent

  Scenario: An intermittent failure is unstable
    Given a failure oracle that expects exit code 1
    And a negative control that exits with code 0
    And candidate runs with exit codes "1,0,1"
    When the reproduction is verified
    Then the outcome is "UNSTABLE"

  Scenario: An absent failure is not reproduced
    Given a failure oracle that expects exit code 1
    And a negative control that exits with code 0
    And candidate runs with exit codes "0,0,0"
    When the reproduction is verified
    Then the outcome is "NOT_REPRODUCED"

  Scenario: A matching control blocks verification
    Given a failure oracle that expects exit code 1
    And a negative control that exits with code 1
    And 3 candidate runs that exit with code 1
    When the reproduction is verified
    Then the outcome is "BLOCKED"

  Scenario: External execution fails closed without an isolated runner
    Given no isolated external runner is configured
    When an external repository execution is requested
    Then execution is blocked before a command runs

  Scenario: The trusted sample produces a portable verified bundle
    Given the trusted CLI spaces sample
    When ReproForge completes the sample investigation
    Then the case state is "VERIFIED"
    And the Repro Bundle validates independently

  Scenario: An over-reduced reproduction is rejected
    Given a verified baseline reproduction
    And a proposed reduction whose control matches the failure
    When ReproForge evaluates the proposed reduction
    Then the baseline is retained

  Scenario: A ChatGPT subscription-first start is keyless and idempotent
    Given a subscription-first trusted ReproForge service
    And no OpenAI API key is configured
    When the caller starts the trusted sample twice with idempotency key "bdd-retry"
    Then one trusted reproduction is executed
    And both starts return the same case and job
    And the service case state is "VERIFIED"

  Scenario: A caller cannot read a case it does not own
    Given a subscription-first trusted ReproForge service
    When the caller reads unknown case "case-not-owned"
    Then the service error code is "NOT_FOUND"

  Scenario: An idempotency key cannot be reused for changed input
    Given a subscription-first trusted ReproForge service
    When the caller reuses idempotency key "bdd-conflict" with a different budget
    Then the service error code is "IDEMPOTENCY_CONFLICT"
    And one trusted reproduction is executed

  Scenario: ChatGPT discovers a closed keyless reproduction app
    Given a subscription-first ReproForge MCP app
    And no OpenAI API key is configured
    When ChatGPT discovers the ReproForge tools
    Then only 5 bounded ReproForge tools are exposed
    And no MCP tool accepts a repository URL, arbitrary command, or API key

  Scenario: ChatGPT retries a trusted reproduction without duplicate execution
    Given a subscription-first ReproForge MCP app
    And no OpenAI API key is configured
    When ChatGPT starts the trusted MCP sample twice with idempotency key "bdd-mcp-retry"
    Then one trusted reproduction is executed
    And both MCP starts return the same case and job
    And the MCP proof status is "VERIFIED"

  Scenario: ChatGPT receives a self-contained proof widget
    Given a subscription-first ReproForge MCP app
    When ChatGPT reads the proof widget resource
    Then the widget uses the MCP App HTML media type
    And the widget declares no external network domains
    And the widget declares its unique production origin
