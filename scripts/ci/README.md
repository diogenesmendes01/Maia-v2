# Hermes pin in integration CI

`hermes-pin.json` records the engine commit already used by Maia's real-worker
fixtures and documented in `docs/dev-environment.md`. Python stays on the 3.12
minor line. Changes to the commit require revalidating the worker ABI, not just
updating this file.

The integration job installs Python 3.12 with `actions/setup-python`, then runs:

```sh
python scripts/ci/setup-hermes-pin.py "$RUNNER_TEMP/maia-hermes-pin"
```

The destination must not exist. The bootstrap fetches the exact commit from
NousResearch, checks its identity, installs an exact uv version in a private
installer venv and installs the real engine from its committed `uv.lock` with
`uv sync --frozen --no-dev`. It checks dependency compatibility and imports the
real `AIAgent` before publishing Python/upstream/SHA outputs. Homes and caches
remain under the destination; no Hermes installer, profile, provider key or
system package modification is needed. Requirements: Linux, Git, Python 3.12
with venv/pip, outbound HTTPS to GitHub and PyPI, and a fresh writable directory.

Only the integration test step receives `HERMES_PIN_*`. The e2e and reliability
lanes do not consume those variables; standalone `tests/hermes-spike` is not
silently added to CI. Existing services, matrices, timeouts and zero-skip gates
are unchanged. This bootstrap is not proof that the whole integration suite or
any paid provider passes.
