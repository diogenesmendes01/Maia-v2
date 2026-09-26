# Dedicated sandbox: doctor, project recipe and test evidence

The canonical versioned recipe is now [docs/dev-environment.md](../dev-environment.md).
This compatibility entry is retained for existing AGENTS.md links and human edits.

Use the root-managed `harness-doctor`, `harness-test-run` and
`harness-project-env` commands from `/srv/agents/bin` after sourcing
`/srv/agents/runtime/env.sh` as `hermes-sandbox`. The full recipe covers runtime
prerequisites, private configuration, isolated DB/Redis setup, dependency install,
migrations, target/full tests, evidence, continuity and limitations.

Prepared tooling is not a passed pilot. Do not change services, shared SC01
resources, merge/deploy or perform a board cutover based on this document.
DEV does not edit AGENTS.md; reusable environment notes belong in the canonical recipe.
