# Ephemeral GitHub CI canary reservation

The VPS allowlist in `tests/helpers/canary-redis-allocation.ts` is unchanged.
A GitHub-hosted job must create its **own** explicit reservation; setting `CI`
does not bypass the file/identity guards. This recipe is not for self-hosted
runners, local sandboxes, VPS test services or personal profiles.

## Workflow integration

`.github/workflows/ci.yml` runs this mandatory step in the `integration` job
**after checkout, setup-node and root `npm ci`, before integration tests**.
Existing service health checks, test commands, summary gates and permissions
remain unchanged. Publication and live CI verification belong to the parent.

```yaml
- name: Reserve this ephemeral runner's canary Redis pair
  shell: bash
  run: |
    set -euo pipefail
    sudo env \
      CI="$CI" GITHUB_ACTIONS="$GITHUB_ACTIONS" \
      RUNNER_ENVIRONMENT="$RUNNER_ENVIRONMENT" \
      GITHUB_REPOSITORY="$GITHUB_REPOSITORY" \
      GITHUB_RUN_ID="$GITHUB_RUN_ID" GITHUB_RUN_ATTEMPT="$GITHUB_RUN_ATTEMPT" \
      GITHUB_JOB="$GITHUB_JOB" GITHUB_WORKSPACE="$GITHUB_WORKSPACE" \
      "$(command -v node)" node_modules/tsx/dist/cli.mjs scripts/setup-ci-canary.ts
    export TEST_CANARY_REDIS_ALLOCATION=/run/maia-ci-canary/allocation.json
    node node_modules/tsx/dist/cli.mjs -e \
      'import { readCanaryRedisAllocation } from "./tests/helpers/canary-redis-allocation.ts"; console.log(readCanaryRedisAllocation());'
    printf 'TEST_CANARY_REDIS_ALLOCATION=%s\n' "$TEST_CANARY_REDIS_ALLOCATION" >> "$GITHUB_ENV"
```

Dependencies/authority:

- Disposable `ubuntu-latest` **GitHub-hosted** VM, standard unprivileged runner
  account with sudo, Node 22.18+ and the repository's installed `tsx` dependency.
- Existing job-exclusive Redis service on loopback port **6379**, with at least
  16 logical DBs. Slots **13 and 14** are reserved solely for this canary; do not
  assign them to other consumers in that job. Main suite uses its existing DB.
  Matrix entries have separate VMs/service containers and do not share slots.
- Existing ephemeral PostgreSQL/pgvector service, integration URLs, migration
  prerequisites and database creation permissions remain required by the live
  spec. Setup does not connect to or mutate Redis/PostgreSQL.
- Only setup runs as root. It creates `/run/maia-ci-canary` mode 0755 and
  `allocation.json` mode 0644, owned by root, using exclusive creation. Tests
  stay unprivileged. No new GitHub token scope, network grant or secret is needed.
- Reservation binds repository, run ID, attempt, job, canonical workspace and
  actual consuming UID. Both setup's exact-content readback and the consumer's
  root-owned/non-writable directory + regular-file inode readback are required.
  `O_NOFOLLOW` rejects file symlinks; hard links, foreign UID, other paths,
  reused reservations, borrowed VPS pairs and DBs 0/1/2 fail closed.
- Setup is intentionally **not idempotent**: an existing directory/file is an
  error, not an allocation to adopt. Restart the ephemeral job, never delete
  somebody else's reservation to force green. VM teardown removes its own
  runtime files/services. This is an operator/runbook guard, not isolation from
  a malicious root process (GitHub-hosted sudo itself is privileged).

## Evidence tiers and local regression commands

`ci-canary-readback.spec.ts` is explicitly an FS/runner-boundary fixture: real
setup/consumer validation, fake filesystem/system identity, no live databases.
The live `worktree-isolamento-canario.spec.ts` remains unchanged and must still
prove database, migration-ledger and Redis isolation on GitHub.

```sh
node node_modules/vitest/vitest.mjs run \
  tests/unit/helpers/ci-canary-reservation.spec.ts \
  tests/unit/helpers/ci-canary-readback.spec.ts \
  tests/unit/helpers/canary-redis-allocation.spec.ts \
  tests/unit/hermes-worker-env-contract.spec.ts \
  tests/unit/hermes-supervisor.spec.ts \
  --maxWorkers=1 --no-file-parallelism --retry=0
node node_modules/typescript/bin/tsc -p tests/fixtures/hermes-next-env/tsconfig.json
npm run admin:typecheck
npm run admin:build
```

Serialize heavy checks with the deployment environment's agreed lock. The
Next-compatible type fixture reproduces the real `ProcessEnv.NODE_ENV`
augmentation but does not stand in for installed admin-ui dependencies. The
supervisor now supplies a literal `NODE_ENV=production` as its own controlled
child value (never forwarded from the host); no `ProcessEnv` assertion, cast,
ambient type weakening, inherited secret or relaxed TypeScript check is used.
