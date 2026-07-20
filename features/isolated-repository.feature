Feature: Isolated repository reproduction
  Authorized immutable repositories are executed through bounded, credential-free
  experiment sandboxes and only deterministic evidence may produce a proof.

  Scenario: An authorized public Node repository produces a verified bundle
    Given an authorized public Node repository proof input
    When the repository proof is assembled
    Then the repository outcome is "VERIFIED"
    And the repository bundle validates independently

  Scenario: An authorized private Node repository produces the same proof shape
    Given equivalent authorized public and private Node repository proof inputs
    When both repository proofs are assembled
    Then the public and private proof shapes are identical

  Scenario: A repository without an immutable revision is rejected
    Given a repository request without an immutable revision
    When the repository source contract is validated
    Then the repository error code is "UNSUPPORTED_SOURCE"
    And no repository provider operation ran

  Scenario: An unsupported lockfile is blocked before sandbox execution
    Given a Node repository with an unsupported lockfile
    When its dependency metadata is validated
    Then the repository error code is "UNSUPPORTED_SOURCE"
    And no repository command ran

  Scenario: A traversal archive is rejected
    Given a repository archive with a traversal path
    When its archive manifest is validated
    Then the archive is rejected before extraction

  Scenario: Dependency acquisition runs with scripts disabled
    Given a supported npm repository dependency fixture
    When repository dependencies are prepared
    Then every npm install disables lifecycle scripts

  Scenario: Repository code runs only after network becomes deny-all
    Given a supported npm repository dependency fixture
    When repository dependencies and the execution plan are prepared
    Then repository-controlled commands follow the deny-all boundary

  Scenario: A reproduction that matches its control is blocked
    Given repository evidence whose control matches the failure
    When the repository proof is assembled
    Then the repository outcome is "BLOCKED"
    And no repository bundle is emitted

  Scenario: An intermittent repository produces UNSTABLE
    Given intermittent repository candidate evidence
    When the repository proof is assembled
    Then the repository outcome is "UNSTABLE"
    And no repository bundle is emitted

  Scenario: A job exceeding its budget stops and reports BUDGET_EXHAUSTED
    Given a repository experiment that exceeds its workspace budget
    When the isolated lifecycle executes the budgeted experiment
    Then the repository error code is "BUDGET_EXHAUSTED"
    And every allocated sandbox resource is cleaned

  Scenario: Cancellation stops commands and cleans the sandbox
    Given an active cancellable repository experiment
    When the repository experiment is cancelled
    Then the repository error code is "CANCELLED"
    And every allocated sandbox resource is cleaned

  Scenario: Provider interruption never fabricates verification
    Given a repository provider that cannot restore a sandbox
    When the isolated lifecycle attempts the repository experiment
    Then the repository error code is "PROVIDER_INTERRUPTED"
    And no verified repository proof exists

  Scenario: No GitHub token appears in evidence or the bundle
    Given repository evidence containing a synthetic GitHub token
    When the repository proof is assembled
    Then the synthetic GitHub token is absent from proof and bundle
