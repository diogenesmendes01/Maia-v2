# Calendar v2 — Runbook operacional

Status: shipped (PR claude/calendar-v2). Default: `FEATURE_CALENDAR_V2=false` (fast-path legacy).

## Visão geral

Calendar v2 dota a Maia v2 de consciência de calendário brasileiro com escopo regional:

- **Feriados nacionais 2025-2035** (fixos + móveis derivados de Easter, Meeus-Jones-Butcher).
- **Regionais** estaduais (UF) e municipais (UF + cidade), seeded com dataset curado (SP, RJ, MG).
- **entity_custom / holding_recess**: feriado vinculado a entidades específicas via junction `holiday_entidades`.
- **Dia útil tenant-aware** com cache LRU (TTL 24h, MAX 2048 entries) — `isBusinessDayBR()` async.
- **RRULE estendido**: `BYNTHWORKDAY=<n>`, `BYWORKDAY=true`, `WORKDAY_KIND=standard|clt` (computed via `computeNextWithBusinessDays`).
- **Pipeline cognitivo**: detector LLM (Haiku) gera proposta `capability_type='holiday'`; owner aprova via tool genérica.

## Feature flag

`FEATURE_CALENDAR_V2` (env var; default `false`).

Quando OFF: `isBusinessDayBR()` cai no fast-path legacy hard-coded (apenas nacionais derivados em código). Comportamento idêntico ao pré-PR. Tools `calendar_*` retornam `calendar_v2_enabled: false`.

Quando ON: lookup via `holidays` table + cache. Migrações 036..040 devem estar aplicadas + seed rodado.

## Kill switch

```js
featureFlags.killSwitch(FeatureFlagName.CALENDAR_V2);
```

Reverte instantâneo (<1min) sem deploy. As 5 tools `calendar_*` continuam expostas mas usam fast-path legacy.

## Migrations

| # | Arquivo | Conteúdo |
|---|---------|----------|
| 055 | `055_calendar_a_entidades_location.sql` | `entidades.cidade` + `entidades.uf` (NULL ok) |
| 056 | `056_calendar_b_holidays.sql` | tabela `holidays` + CHECK `regional_consistency` + CHECK `pending_must_have_proposal` |
| 057 | `057_calendar_c_holiday_entidades.sql` | junction `holiday_entidades` (composite PK) |
| 058 | `058_calendar_d_capability_proposals_holiday_type.sql` | adiciona `'holiday'` ao CHECK de `capability_proposals.capability_type` |
| 059 | `059_calendar_e_holidays_unique_idem.sql` | UNIQUE index para idempotência de seed |

Cada um tem `_down.sql` correspondente (wrapped em `BEGIN/COMMIT`; migration 058 inclui `LOCK EXCLUSIVE` antes do DELETE para evitar race com INSERTs concorrentes).

## Seed

```bash
tsx scripts/seed-holidays.ts                                  # todos os tenants, 2025..2035
tsx scripts/seed-holidays.ts --tenant tenant-a --start 2026 --end 2030
```

Idempotente via `holidays_unique_idem` UNIQUE index. Insere ~14 nacionais × N anos × tenants + ~6 regionais por tenant.

## Tools registradas

### Read-only (sempre expostas, mesmo com flag OFF — fallback legacy):
1. `calendar_is_business_day`
2. `calendar_next_holiday`
3. `calendar_list_holidays`
4. `calendar_business_days_between`
5. `calendar_add_business_days`

### Write / governança (gated por `FEATURE_CALENDAR_V2`):
6. `register_custom_holiday` (owner cria entity_custom / holding_recess)
7. `approve_capability_proposal` (P5 closure genérica; dispatcher por `capability_type`)
8. `reject_capability_proposal`
9. `list_pending_proposals`

`calendar_*` tools NÃO emitem `cognitive_module_log` (não são módulos LLM-backed; lookup determinístico). O módulo cognitivo real é `calendar-pattern-detector` (`src/cognition/`), wrapped em `runCognitiveModule` e auditado.

## Isolamento cross-tenant (P0 invariant)

- `holidays.tenant_id NOT NULL`, REFERENCES `tenants(id)`.
- `holiday_entidades.tenant_id NOT NULL` (denormalizado para guard runtime).
- `holidaysRepo` e `holidayEntidadesRepo` chamam `getCurrentTenant()` (throw se ausente).
- `holidayEntidadesRepo.link()` pre-checka tenant DO holiday + tenant DA entidade antes de INSERT (`CrossTenantIntegrityError` se desbate).
- Cache key inclui `tenant_id`: `${tenant_id}:${entidadeId|global}:${year}:${kind}`.
- Invalidação broad-por-tenant — nunca toca outros tenants.

Validado por `tests/integration/calendar-v2-isolation.spec.ts` + `tests/integration/calendar-v2-approval-pipeline.spec.ts` (Cenário 5).

## Métricas a observar pós-deploy

- `cognitive_module_log` rows com `module='calendar_pattern_detector'` — esperado ~5/dia/tenant ativo no início.
- Taxa de aprovação vs rejeição de proposals `capability_type='holiday'`.
- `capability_test_results` outcome=fail para strategy=holiday_calendar_check — esperado: 0.
- Cache size (`_internal_cache.size()`) deve estabilizar bem abaixo de 2048.

## Rollback

1. **Hot**: `featureFlags.killSwitch(FeatureFlagName.CALENDAR_V2)` — instantâneo, sem deploy.
2. **Frio**: rodar migrations down 040 → 036 em ordem reversa via `psql -f`. Perda de dados em `holidays` é esperada (mantém integridade de FK).

## Limitações / deferred

- **rrule async migration**: `computeNext` em `src/scheduling/rrule.ts` continua síncrono (back-compat). Nova função `computeNextWithBusinessDays` (async) em `src/scheduling/business-day-rrule.ts` é o entrypoint para BYNTHWORKDAY/BYWORKDAY. Call-sites de scheduling/recurring-payment/recurring-outreach NÃO foram migrados ainda — feature de "feriado prorroga BYMONTHDAY" requer essa migração ou nova série de tool variants.
- **Persister branch**: detector ainda não está wired no `conversation-summarizer`. Quando wired, escreverá descriptor `holiday:...` no payload da capability_proposal seguindo o parser `parseHolidayDescriptor`.
- **Prompt-builder injection** (hoje + próximo feriado + bullet mentionable): não implementado — depende de não-quebrar 26 testes pré-existentes do prompt-builder.

Essas peças podem entrar em PRs incrementais sem mexer no contrato deste primeiro PR (schema + tools + pipeline-approval-side fechados).

## Tabela verdade — Easter 2025-2035

Validada via `tests/unit/easter.spec.ts` (Meeus-Jones-Butcher):

| Ano | Páscoa |
|-----|--------|
| 2025 | 2025-04-20 |
| 2026 | 2026-04-05 |
| 2027 | 2027-03-28 |
| 2028 | 2028-04-16 |
| 2029 | 2029-04-01 |
| 2030 | 2030-04-21 |
| 2031 | 2031-04-13 |
| 2032 | 2032-03-28 |
| 2033 | 2033-04-17 |
| 2034 | 2034-04-09 |
| 2035 | 2035-03-25 |

## Diagnóstico — queries úteis

```sql
-- feriados de um tenant
SELECT type, name, month, day, year, uf, cidade, status
FROM holidays
WHERE tenant_id = '<tid>'
ORDER BY month, day;

-- proposals pendentes
SELECT id, capability_type, title, status, created_at
FROM capability_proposals
WHERE tenant_id = '<tid>' AND status = 'submitted' AND capability_type = 'holiday'
ORDER BY created_at DESC;
```
