# Development environment — dedicated harness sandbox

Status: **prepared, not a passed pilot**. These commands are for `code-dev` and
`code-qa` running as Unix user `hermes-sandbox` in independent linked worktrees.
They do not migrate a board, change profiles, start infrastructure, merge or deploy.
Do not use them to alter the active SC01 checkout or its DB/Redis. DEV does not edit AGENTS.md; reusable environment notes belong here. The existing `npm run doctor` is the application doctor;
this lightweight harness doctor is a different, dependency-free command.

## 1. Operator prerequisites (not actions for DEV/QA)

- Clone based on `claude/hermes-core-wiring`; each card/QA revision gets a writable
  linked worktree, which may live outside the clone directory.
- User-managed Node from `.nvmrc`, accepted by `scripts/check-node.mjs`, and
  npm pinned by `package.json` (currently Node >=22.13.0 <23, npm 11.5.2).
  Python 3 stdlib, Git, `gh`, PostgreSQL client tools must be available on PATH.
- Fine-grained repository credential, not root/Olympia/admin credentials. The
  doctor only verifies authenticated GitHub API access, **not write/PR grants**.
  Full permission and negative-access tests belong in operator preflight.
- Root-managed localhost PostgreSQL instance **exclusively for tests**, sandbox
  role CREATEDB / NOSUPERUSER / NOCREATEROLE, explicit CONNECT to maintenance
  database `maia_maintenance` on 127.0.0.1:5435 (role `hermes_sandbox`). No production/Olympia databases or credentials.
- **Template prerequisite:** migrations 001/002 request `uuid-ossp`, `pgcrypto`,
  `vector`, `btree_gin`, `pg_trgm`. Operator supplies a test-only template containing
  these extensions (particularly pgvector, which a nonsuperuser cannot normally
  install), with access/ownership verified for the sandbox role. No schema ledger
  from another card. Do not grant superuser to solve this. Set
  `HARNESS_PG_TEMPLATE` to that verified template. Template/migration usability is
  a pilot gate, not proven by the doctor's cheap connectivity query.
- Dedicated test Redis and an exclusively allocated **nonzero logical DB** per
  card/QA worktree. A prefix alone does not isolate BullMQ. No shared SC01 cache.
- Real storage paths for repo, dependencies/cache and PostgreSQL. Operator
  supplies paths the sandbox can stat (mount root is enough when DB directory
  itself is private); disk >=80% is a failure. This probe is not a persistent alert.

CREATEDB does not constrain database names. `card_<id>` is a recipe convention,
not a security boundary; a shared role does not isolate cards. HBA/CONNECT,
cgroup quotas, template access and resource retention are operator acceptance.

## 2. Explicit local configuration and diagnostic-only doctor

Use the revision-owned `scripts/harness/.env.example` as the **separate test-only template**. The
root `.env.example` is generated from the application contract and is intentionally
unchanged. Fill a private, operator-approved file with only dedicated-test values;
source only a trusted file, never pasted shell from a card. Do not copy production
`.env`, print credentials, use `set -x`, or place URLs/passwords on command lines.
The doctor does not source files automatically.

```bash
# Bash, as hermes-sandbox, from the card linked worktree (not /root).
source /srv/agents/runtime/env.sh
command -v harness-doctor harness-test-run harness-project-env
set -a
. "$HOME/.config/maia-harness-test.env"
set +a
harness-doctor
```

Doctor prints exactly six lines in order: `uid`, `node`, `worktree`, `github`,
`postgres`, `disk`. Format: `OK <check>` or `FALHA <check>: <short reason>`.
All checks run independently; unexpected exceptions are sanitized to class names,
never exception text. Exit 0 only if all pass; otherwise 1. Each child probe has
1.5s timeout, PostgreSQL additionally has connect/statement deadlines. No install,
fetch, test, migration, create-resource or automatic repair runs inside doctor.
Network error/timeout is failure, not skipped success. Record elapsed time during
both real executor pilots; filesystem latency and multiple Git commands also
contribute to total runtime. A root development smoke must fail UID.

If doctor fails, retain relevant FALHA lines and block for environment resolution;
do not fix host infrastructure. Missing `/srv/agents/...` or test services is
**not configured**, not a passing pilot. Doctor uses the maintenance DB so it can
pass before the card DB exists. A successful doctor does not validate migrations
or claim the recipe below has executed.

### Provisioned service handoff

Source `/srv/agents/runtime/test-services.env` only when operator-provisioned. It
provides the dedicated Redis endpoint and Hermes Python/upstream paths; do not
substitute a pre-existing Redis or installed Hermes HEAD. Verify upstream SHA
`5d59366010640c1d6b8f170d8a4ee109db2bbdef` and Python3.12. Keep
`MAIA_HERMES_UPSTREAM` and `MAIA_HERMES_WORKER_PYTHON` explicit: missing pins can
skip spike tests. Existing `.nvmrc` and `packageManager` own Node/npm versions.

The revision-owned `python3 scripts/harness/project_env.py -- ...` is the
project recipe launcher. Use it below in place of `harness-project-env` until
the operator promotes this revision: the older installed launcher strips the
two Hermes paths. Do not update the root-owned package from a project task.
The installed `harness-test-run` remains the evidence wrapper.

## 3. Install dependencies (in this worktree only)

Once doctor passes, run the project's normal install separately:

```bash
# PATH must already select the user-managed Node/npm versions; no sudo/global host changes.
node scripts/check-node.mjs
npm --version
mkdir -p "$HOME/.cache/maia-harness/tmp"
export TMPDIR="$HOME/.cache/maia-harness/tmp"
env -i PATH="$PATH" HOME="$HOME" TMPDIR="$TMPDIR" \
  DOTENV_CONFIG_PATH=/dev/null NODE_ENV=test npm ci --no-audit --no-fund
```

Use an install belonging to the delivered lockfile. Do not share mutable
node_modules/Vite caches with SC01 or another live test run. QA has its own
writable dependencies/cache. Never regenerate the lockfile with an unsupported npm.

## 4. Create card DB, migrate, run target and complete backend suite

Allocate a fresh `HARNESS_CARD_DATABASE=card_<id>` and exclusive Redis slot first.
`DATABASE_URL` and `TEST_DB_URL` must be identical, match the configured localhost
PG host/port/user, and end with that exact card database. Supply URL-encoded test
credentials privately. `REDIS_URL` must match `HARNESS_REDIS_PORT` and
`HARNESS_REDIS_DB`. No implicit 5432/6379 fallback.

`project_env.py` rejects missing/mismatched/remote URLs **before executing the
command**, builds an allowlisted environment, sets NODE_ENV=test and
DOTENV_CONFIG_PATH=/dev/null, and removes inherited provider tokens, MAIA_ENV,
NODE_OPTIONS and dotenv override knobs. It explicitly sets
TEST_WORKTREE_SCOPE=off **only for this manual per-card recipe**: otherwise existing
`globalSetup.ts` changes the database name, creates another DB from the default
template and flushes an automatically allocated Redis slot. Never use this opt-out
without the explicit exclusive card DB/Redis allocation. The script is not a
security sandbox for arbitrary commands or malicious tests.

```bash
# Template must be verified by operator. Failure does not trigger a fallback.
: "${HARNESS_PG_TEMPLATE:?operator must configure test template}"
harness-project-env -- \
  createdb --maintenance-db=maia_maintenance --template="$HARNESS_PG_TEMPLATE" "$HARNESS_CARD_DATABASE"
# On resume, do not recreate/drop an existing database: inspect card ownership and
# migration status, then continue only on the SAME card database.
harness-project-env -- npm run db:migrate -- up

# Choose an actual target in the delivered revision; no invented SC01 filename.
: "${TARGET_SPEC:?set the actual card test path}"
: "${EVIDENCE_ROOT:?set a private persistent evidence directory outside Git}"
harness-project-env -- harness-test-run \
  --out "$EVIDENCE_ROOT/target-01" --parser vitest-json -- \
  node node_modules/vitest/vitest.mjs run "$TARGET_SPEC" \
  --pool=forks --maxWorkers=1 --no-file-parallelism --retry=0

# Full backend suite: integration is enabled because TEST_DB_URL is present.
harness-project-env -- harness-test-run \
  --out "$EVIDENCE_ROOT/suite-01" --parser vitest-json -- \
  node node_modules/vitest/vitest.mjs run \
  --pool=forks --maxWorkers=1 --no-file-parallelism --retry=0
```

Run each line only after the preceding line succeeds; do not use a pipeline that
masks the wrapper's status. On resume use a NEW evidence directory per run. No
DB drop/Redis FLUSHALL is part of the recipe. Initial DB/slot must be fresh;
fixtures must clean only their own scoped records. After an interrupted suite,
inspect its fixtures and terminate orphaned workers before a retry. Do not run
DEV and QA against the same DB/slot. Existing `src/db/client.ts` pool max is 10,
not a configurable `DB_POOL_MAX`; specs can create additional pools. One Vitest
worker and WIP1 reduce pressure but do not prove a connection cap—measure during
pilot. Fork isolation, retry=0 and local caches avoid masking SC01's module/mock,
fixture and timeout classes. Do not silently enlarge timeouts to obtain green.

The backend suite does not replace separate admin-ui/Playwright, Hermes spike
or live acceptance lanes required by a card. Their environment and explicit
skips must be reported separately. The recipe's migrations/full integration
remain **NOT VERIFIED** until a provisioned sandbox executor runs them.

## 5. Evidence wrapper contract

For direct Vitest CLI use `--parser vitest-json`. It appends default + JSON
reporters and a fresh absolute `--outputFile` under the new evidence directory.
This overrides configured reporters: use retry=0 as above; the wrapper does not
infer absorbed retries. Do not supply conflicting reporter/outputFile flags.
For other runners, omit `--parser`: counts/failures are explicitly `unknown`.
No heuristic parsing of arbitrary green console text.

Outputs (directory mode 0700):
- `full.log`: complete combined stdout/stderr bytes, not a truncated tool excerpt;
- `vitest.json`: original reporter artifact when supported;
- `summary.json`: requested and executed argv, original child exit code/signal,
  duration, counts, failure names/messages, coverage and parse/launch errors.

`executed=passed+failed`; skipped and todo are separate, never executed. Missing,
malformed or internally inconsistent reports produce `unknown`; parse errors
never replace the original test exit. A signalled child records negative raw
status and returns shell convention 128+signal. Launch failure is 127 with
`launch_error`, not an invented failed test. `coverage=complete` means no skips
in this report, **not acceptance passed**. Exit 0 with unknown/partial coverage
cannot establish complete acceptance. Full logs/argv may contain whatever a
child emits: do not pass secrets in argv or publish raw logs without review.

## 6. Why `prod-env.ts` needs care

Inspected `src/runtime/decision/prod-env.ts`: it is production **dependency
composition**, not a file that loads a production dotenv. It imports real DB
repositories/client and LLM gateway; tests must inject/mock those boundaries or
use explicit synthetic integration fixtures, never call real providers/channels.
`src/db/client.ts` obtains DATABASE_URL through `src/config/contract-env.ts`;
that module and `src/config/env.ts` load dotenv at import time. The contract
loader `src/config/load.ts` itself is side-effect free and accepts an env snapshot.
Without explicit test overrides, worktree helpers default to localhost ports
5432/6379. `tests/setup.ts` rewrites DATABASE_URL from TEST_DB_URL and supplies
synthetic provider values; NODE_ENV=test alone is **not** a network fence.

The allowlisted recipe prevents inherited production environment and automatic
root `.env` loading. It does not claim all test code is incapable of making
network requests; use synthetic adapters and operator egress policy where
required. No production configuration or application runtime was changed here.

## 7. Tool regression commands (no services required)

```bash
python3 -B -m unittest discover -s /srv/agents/lib/harness-tools/tests/harness -v
harness-test-run --out "$EVIDENCE_ROOT/wrapper-smoke" \
  --parser vitest-json -- node node_modules/vitest/vitest.mjs run \
  --config tests/harness/vitest.config.mjs
```

The Vitest fixture intentionally includes one skip and one todo; with
HARNESS_FIXTURE_FAIL=1 it also produces one real assertion failure. These prove
the wrapper, not Maia integration or the dedicated pilot. Doctor tests use real
subprocess fixtures at the GitHub/psql boundary to exercise failures/timeouts;
no GitHub/DB outage is injected into shared services. Aggregate all-OK is tested
with injected checks, not misrepresented as actual sandbox readiness.

## 8. Installed tooling, continuation and human application

The root-managed commands are outside the repository, on PATH after sourcing
`/srv/agents/runtime/env.sh`: `/srv/agents/bin/harness-doctor`,
`harness-test-run`, `harness-project-env`. They resolve to
`/srv/agents/lib/harness-tools/scripts/harness/`. The adjacent runtime dependency
`/srv/agents/lib/harness-tools/scripts/check-node.mjs` is deliberately included:
copying doctor.py alone breaks its Node probe. Python tools use only stdlib;
Node guard is dependency-free. Python3, Node22, Git, gh and psql remain explicit
runtime requirements. The package manifest records source SHA and file hashes.
Root owns bin, lib, bundle and their files; directories0755, scripts0755,
data0644, no group/other write. DEV/QA must not replace this operator package.
No repository commit, automatic service activation or shell startup edit is
needed to use it. Source the runtime entry explicitly in a new shell/session;
this document does not claim already-running workers inherit a changed PATH.

At start/resume, read the card, run doctor, then check Git HEAD/branch/diff and
DEV's `.agent/checkpoint.md`. Recheck card on new state/review, not repeatedly
without reason. DEV overwrites at most30 lines: Estado, Problema atual/reproducer,
Já tentado, Próxima ação, Notas de ambiente. Update on progress and before long
operations, review, blocking and budget exhaustion. Derive Git facts from Git,
not stale prose. `.agent/` must be locally excluded in the Git common-dir
`info/exclude`; verify with `git check-ignore -v .agent/checkpoint.md` in every
worktree. This is not a tracked .gitignore change and not a PR artifact.
QA neither writes checkpoint nor treats it as proof. Independent AC evidence,
SHA and commands/logs remain mandatory. Keep decision/block/handoff comments on
the card; the checkpoint is not a replacement and full logs belong in artifacts.

`AGENTS.md.proposed` is a **human-only draft**, explicitly authorized by the user
for review, not permission for an agent to edit/apply the protected AGENTS.md.
It is based on the package's recorded base and adds only a short §7.0 directing
the dedicated harness here. Do not copy it over an AGENTS.md changed by a human:
compare and insert only the missing subsection manually on the VPS. The old
`docs/ai/harness-test-environment.md` path remains a compatibility link.

Human review/apply sequence (not executed by this delivery):
1. Inspect `git status --short`, preserve any human AGENTS.md changes, and inspect
   the separate `claude/harness-integration-instructions` branch diff.
2. Read this recipe and compare the proposed §7.0 with the current live manual;
   use an editor to apply only the intended missing guidance. No automatic copy
   or patch command is required or authorized here.
3. Review/commit your AGENTS.md edit separately. Integrate the recipe branch only
   when satisfied; it does not modify AGENTS.md and has not been merged/pushed.
4. Keep services/board cutover gated. Passing package checks is not a real
   DEV→QA pilot or verification of migrations, Redis, credentials, cgroups or PM wakes.
