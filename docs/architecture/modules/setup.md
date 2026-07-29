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
| HTTP endpoints in `src/server.ts` | `/setup` consumes the setup-token — via the `POST /setup/session` form (token in the BODY, traded for an `httpOnly` session cookie) or the `x-maia-setup-token` header for break-glass. **Never via query string** (issue #518) |
| `src/admin-ui/trpc/routers/channelLines.ts` | Pareamento de linhas ADICIONAIS na jornada normal: o console autenticado enfileira comandos em `channel_line_state` e o worker `channel_pairing` executa `line-pairing.ts`. Os endpoints `/setup/channels/:id/pair*` ficam como break-glass |
| `src/setup/pairing-material.ts` | Cifra o QR/código para a travessia console↔runtime (envelope AES-GCM do keyring de staging); TTL curto, nunca em claro, nunca em log/audit/URL |
| `src/setup/line-readiness.ts` | Gate DETERMINÍSTICO de roteamento (#518 §4): posse provada não ativa o canal — a linha só roteia com PERFIL OPERACIONAL ATIVO do agente, política de canal e papel padrão ativo (a mesma sequência do go-live checklist). `line-pairing` consulta no fim do pareamento; o worker `channel_pairing` revalida a cada minuto e ativa sozinho quando as condições aparecem |
| `src/runtime/instance-identity.ts` | Fonte única de "quem eu sou" (`<hostname>:<pid>`) — worker e gateway precisam concordar para endereçar comandos à réplica que segura o socket da linha |

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
