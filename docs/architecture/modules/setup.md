# setup

**Path:** `src/setup/`

**Purpose** — Bootstrap and recovery flow for fresh deployments. Creates `self_state` + owner + (optionally) entities + accounts + permissions via the `npm run setup` CLI wizard. Manages the Baileys auth directory (`BAILEYS_AUTH_DIR`) and the bootstrap setup-token used to pair WhatsApp on first run or after a `LoggedOut` event. Generates QR PNGs and HTTP endpoints for the pairing flow.

## Key files

| File | Role |
|---|---|
| `src/setup/index.ts` | Wizard entry point (invoked by `npm run setup`) |
| `src/setup/state.ts` | Initial `self_state` row creation |
| `src/setup/templates.ts` | Entity / account / permission templates |
| `src/setup/auth-dir.ts` | Manages `BAILEYS_AUTH_DIR` lifecycle |
| `src/setup/token.ts` | Setup-token issuance + validation |
| `src/setup/qr-png.ts` | QR code PNG generation |
| `src/setup/recovery.ts` | Recovery flow after `LoggedOut` |

## Patterns it follows

- Bootstrap is the **only** code path that may write the `'default'` literal — every other path rejects it (see [tenant-isolation](../concerns/tenant-isolation.md))
- Setup is idempotent: running the wizard twice does not duplicate rows; existing state is preserved

## How to extend

| Need | Where |
|---|---|
| Add a wizard step | Extend `index.ts`; new template in `templates.ts` if needed |
| Add a recovery scenario | Extend `recovery.ts`; document operator action in `docs/runbooks/setup-nginx.md` or the WhatsApp migration runbook |
| Change the auth-dir layout | Edit `auth-dir.ts`; document migration in the relevant runbook |

## Public surface

| Consumed by | What |
|---|---|
| `scripts/setup.ts` | CLI invokes the wizard |
| `src/gateway/baileys.ts` | Reads `BAILEYS_AUTH_DIR` and setup token |
| HTTP endpoints in `src/server.ts` | `/setup?token=...` consumes setup-token |

## Tests

| Test path | What it covers |
|---|---|
| `tests/unit/setup/` | Wizard + token + auth-dir contracts |
| `tests/integration/setup/` | End-to-end wizard run |

## In-flight changes

At last verification (2026-05-28): none specifically scoped to `src/setup/`.

Verify: `gh pr list --state open --search "setup OR bootstrap OR baileys-auth"`.

---

| | |
|---|---|
| Last verified | 2026-05-28 |
| Against `main` HEAD | `c49c3855` |
