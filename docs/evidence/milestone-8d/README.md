# Milestone 8D evidence

This directory holds sanitized local and hosted evidence for private-beta
completion. Local screenshots prove responsive rendering and accessibility
structure only; they do not substitute for the public/private deployed canary
or live provider gates required by the milestone specification.

Evidence is added incrementally and tied to an exact Git commit in
`manifest.json` before Milestone 8D can be marked complete.

## Current verified slice

Exact implementation commit
`8f4464c4dfefd00e6ccff79f1e8796688828e669` adds a real isolated-runner
capability probe, fail-closed validation of the complete hosted product
configuration, and one durable progress projection shared by REST, MCP,
ChatGPT widget, and tenant-scoped web case views.

The progress property gate passed 500 generated schedules. Focused contract
tests passed 13/13, Cucumber passed 40 scenarios and 289 steps, TypeScript and
ESLint passed, and the production Next.js build completed. Browser inspection
found meaningful content, no framework error overlay, no page errors, and no
horizontal overflow at a 390 × 844 mobile viewport. Development-console output
contained only Next.js/HMR notices.

## Local visual evidence

![Desktop ReproForge ChatGPT widget preview showing verified proof, evidence, runs, and bundle state.](local-widget-desktop.png)

![Mobile ReproForge ChatGPT widget preview showing verified proof without horizontal overflow.](local-widget-mobile.png)

![Desktop ReproForge case page showing the tenant-scoped identity boundary while Auth0 is not configured.](local-case-auth-boundary-desktop.png)

![Mobile ReproForge case page showing the tenant-scoped identity boundary without horizontal overflow.](local-case-auth-boundary-mobile.png)

These captures intentionally prove only the local widget presentation,
responsive layout, and fail-closed account boundary. They are not live Auth0,
GitHub App, hosted ChatGPT, or public/private canary evidence. Those gates remain
open and keep the milestone status `in-progress`.
