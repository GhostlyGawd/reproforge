Feature: Private-beta ReproForge
  The hosted product must expose one durable truth across every user surface.

  Scenario: The same case is visible consistently in ChatGPT and the web app
    Given a durable private-beta case is experimenting
    When REST, MCP, widget, and web progress views are projected
    Then every product surface reports the same durable progress
