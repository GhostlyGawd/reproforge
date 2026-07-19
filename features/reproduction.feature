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
