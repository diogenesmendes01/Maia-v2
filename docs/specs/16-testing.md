# Spec 16 — Testing Strategy

**Status:** Foundation • **Phase:** 1 • **Depends on:** 00, 02, 03, 06, 07, 09

---

## 1. Purpose

Define the test strategy for Maia. Coverage goals, test categories, the **entity-leak suite** (the most important test in the system), fixtures, mocking strategy, and CI hooks.

## 2. Goals

- Three test categories with clear ownership: unit, integration, end-to-end.
- A **dedicated leak-test suite** that proves every entity-scoped query refuses cross-entity access.
- Deterministic test data via factories, not seed dumps.
- Fast feedback: unit tests run in < 5s; integration in < 30s; E2E in < 2 min.
- CI gate: no merge without leak suite passing.

## 3. Non-goals

- 100% line coverage as a target. Quality > number.
- Property-based testing across the board. Use only where it pays off (validators, parsers).
- Visual regression for dashboard. Phase 5 concern.

## 4. Tooling

- **Test runner:** Vitest.
- **DB tests:** real Postgres in a Docker container, throw-away per test run; transactions per test where possible.
- **Redis tests:** real Redis container; flushed per test.
- **HTTP mocks:** undici interceptor for Anthropic / OpenAI / Voyage / Telegram.
- **Fixtures:** factory functions returning typed builders, not JSON dumps.

## 5. Test categories

### 5.1 Unit tests

- Live in `tests/unit/<module>.spec.ts` mirroring `src/`.
- Pure functions: `lib/brazilian.ts`, `governance/dual-approval.ts`, `tools/idempotency.ts`, etc.
- No DB, no Redis, no network. Mock provider clients with handcrafted fakes.
- Examples:
  - `isValidCPF` against 50 known-good and 50 known-bad cases.
  - `parseBRL` across all documented edge cases.
  - `requiresDualApproval` for every triggerable combination.
  - `computeIdempotencyKey` deterministic across 100 randomized inputs.

### 5.2 Integration tests

- Live in `tests/integration/`.
- Real Postgres + Redis (Docker). One test runs against a clean DB schema.
- Test the full **tool dispatch pipeline** (spec 07): from intent to audit log, exercising permission, limit, audit-mode, and idempotency.
- Test **identity resolver** with real `pessoas` rows.
- Test **workflow engine** advancing dual-approval over simulated time (using clock injection).

### 5.3 End-to-end (smoke)

- Live in `tests/e2e/`.
- Spawn the full app process with mocked Baileys (a `MockSocket` that emits canned messages).
- A handful of golden-path scenarios:
  1. Owner registers a R$ 50 transaction and gets the confirmation reply.
  2. Owner registers R$ 25k → dual approval requested → spouse approves → executes.
  3. Quarantined newcomer message → owner confirms → newcomer gets welcome.
  4. Audit-mode-active owner: action returns preview; "sim" executes.
  5. Lockdown command → spouse and contador receive maintenance message.

## 6. The entity-leak suite (must-pass)

### 6.1 Why

Cross-entity leakage is the single most expensive failure mode. A single bug here exposes finances of one company to another's employee. This suite is the **primary defense**.

### 6.2 What it tests

For every repository method that reads entity-scoped data, **two-pessoa fixture**:

```
Setup:
  pessoa_A: dono_total on entidade_A only
  pessoa_B: dono_total on entidade_B only
  entidade_A and entidade_B with distinct transactions, accounts, recurrences, contrapartes

Property: for every read repository method M:
  forall row r in entidade_B:
    M(scope_A, ...).should_not_contain(r)
```

Concretely:

```typescript
describe('entity leak suite', () => {
  for (const repo of READ_REPOS) {
    for (const method of repo.READ_METHODS) {
      it(`${repo.name}.${method} respects entity scope`, async () => {
        const scopeA = await scopeOf(pessoaA);
        const result = await repo[method](scopeA, defaultFiltersFor(method));
        expect(result.every(row => row.entidade_id === entidadeA.id)).toBe(true);
      });
    }
  }
});
```

`READ_REPOS` and `READ_METHODS` are populated via decorators / metadata so adding a new method automatically extends the suite.

### 6.3 Constitutional rules suite

Each `CONSTITUTIONAL_RULE` has a dedicated test:

```typescript
describe('C-004 cross-entity in tool intent', () => {
  it('rejects register_transaction for an entity outside scope', async () => {
    const intent = makeIntent('register_transaction', { entidade_id: entidadeB.id, ... });
    const result = await dispatchTool(intent, ctxFor(pessoaA));
    expect(result.error).toEqual({ kind: 'forbidden', reason: 'Acesso fora do escopo' });
  });
});
```

## 7. Fixtures via factories

```typescript
// tests/factories/pessoa.ts
export function makePessoa(overrides?: Partial<Pessoa>): Pessoa {
  return {
    id: uuid(),
    nome: faker.person.firstName(),
    telefone_whatsapp: `+5511${faker.number.int({ min: 900000000, max: 999999999 })}`,
    tipo: 'funcionario',
    status: 'ativa',
    preferencias: {},
    modelo_mental: {},
    created_at: new Date(),
    updated_at: new Date(),
    ...overrides,
  };
}
```

Use `faker.seed(<n>)` per test to make randomness deterministic.

## 8. Mocking external services

```typescript
// Anthropic mock
mockAnthropic.onCall().reply((req) => {
  if (req.system.includes('classificacao')) {
    return { content: [{ type: 'text', text: '{"categoria_id":"cat-aluguel","confianca":0.92}' }] };
  }
  return { content: [{ type: 'tool_use', name: 'register_transaction', input: { ... } }] };
});
```

Each integration test sets the expected sequence of LLM responses. Flaky LLM behavior is impossible because the LLM is mocked.

A small set of **contract tests** runs against the real Anthropic API (manual / nightly, not in CI by default). These verify our SDK usage is current.

## 9. Coverage targets

| Module | Target |
|---|---|
| `lib/brazilian.ts` | 95% lines, 100% branches |
| `governance/*` | 90% |
| `tools/*` | 80% (handlers covered by integration) |
| `agent/core.ts` | 70% (heavy mocking; quality > %) |
| Total project | 70% lines, leak suite 100% |

## 10. CI hooks

`tests` script in `package.json`:

- `npm test` → unit (fast)
- `npm run test:integration` → with Docker DB
- `npm run test:e2e` → with mock Baileys
- `npm run test:leak` → must always pass; also runs in `test`

GitHub Actions / equivalent on every PR:

1. lint
2. typecheck
3. unit + leak (parallel)
4. integration (depends on 1-3)
5. e2e (depends on 1-4)

PR cannot merge if leak suite fails.

## 11. Observability of tests

Failed tests post a structured summary including: failing seed, failing inputs, captured logs (with secrets redacted via the same Pino redact rules — spec 17).

## 12. Acceptance criteria

- [ ] Leak suite covers every repository read method.
- [ ] Adding a new repository method without scope causes leak suite to fail (proven by deliberate offending PR).
- [ ] CI runs full unit + leak in < 90 seconds.
- [ ] Integration tests are isolated (one test does not leak state to another).
- [ ] E2E smoke tests boot the app, mock Baileys, exercise 5 scenarios in < 2 minutes.

## 13. References

- Spec 02 — repositories under test
- Spec 03 — profiles, permissions
- Spec 06 — agent loop
- Spec 09 — constitutional rules
- Spec 17 — log redaction in test output
