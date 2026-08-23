import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runCognitiveModule } from '@/cognition/runner.js';
import { runWithTenantContext } from '@/db/tenant-context.js';

vi.mock('@/db/repositories.js', async () => {
  const actual = await vi.importActual<typeof import('@/db/repositories.js')>('@/db/repositories.js');
  return {
    ...actual,
    cognitiveModuleLogRepo: {
      record: vi.fn(async () => {}),
      recentByModule: vi.fn(async () => []),
    },
  };
});

describe('runCognitiveModule', () => {
  beforeEach(() => vi.clearAllMocks());

  it('execução normal: retorna output + status=success + audit log', async () => {
    await runWithTenantContext({ tenant_id: 'default', agent_id: 'default' }, async () => {
      const result = await runCognitiveModule(
        { name: 'test.module', triggered_by: 'sync_required' },
        async () => 'hello',
      );
      expect(result.output).toBe('hello');
      expect(result.status).toBe('success');
      expect(result.fallback_triggered).toBe(false);
    });
  });

  it('timeout: retorna fallback + status=timeout', async () => {
    await runWithTenantContext({ tenant_id: 'default', agent_id: 'default' }, async () => {
      const result = await runCognitiveModule(
        { name: 'test.slow', triggered_by: 'sync_conditional', timeoutMs: 50, fallback: 'fb' },
        async () => new Promise((r) => setTimeout(() => r('slow'), 200)),
      );
      expect(result.output).toBe('fb');
      expect(result.status).toBe('timeout');
      expect(result.fallback_triggered).toBe(true);
    });
  });

  it('erro do módulo: retorna fallback + status=error', async () => {
    await runWithTenantContext({ tenant_id: 'default', agent_id: 'default' }, async () => {
      const result = await runCognitiveModule(
        { name: 'test.boom', triggered_by: 'async_event', fallback: null },
        async () => { throw new Error('boom'); },
      );
      expect(result.output).toBeNull();
      expect(result.status).toBe('error');
      expect(result.fallback_triggered).toBe(true);
    });
  });

  it('sem fallback + erro: output null mas não throw', async () => {
    await runWithTenantContext({ tenant_id: 'default', agent_id: 'default' }, async () => {
      const result = await runCognitiveModule(
        { name: 'test.boom2', triggered_by: 'async_event' },
        async () => { throw new Error('boom'); },
      );
      expect(result.output).toBeNull();
      expect(result.status).toBe('error');
    });
  });

  // -------------------------------------------------------------------------
  // PR #269 review — fail-closed audit when tenant context is missing or
  // malformed. The primary module must still complete; only the audit row is
  // skipped (the alternative — writing under ('default','default') — silenced
  // caller bugs and polluted the audit table with a cross-tenant bucket).
  // -------------------------------------------------------------------------
  describe('PR #269 — fail-closed audit on missing tenant context', () => {
    it('primary module still returns success when called OUTSIDE runWithTenantContext', async () => {
      // No runWithTenantContext wrapper → audit must be skipped, but the
      // primary module result must propagate normally.
      const result = await runCognitiveModule(
        { name: 'test.no-context', triggered_by: 'sync_required' },
        async () => 'primary-ok',
      );
      expect(result.output).toBe('primary-ok');
      expect(result.status).toBe('success');
      expect(result.fallback_triggered).toBe(false);
    });

    it('audit log is NOT written when called OUTSIDE runWithTenantContext', async () => {
      const repo = await import('@/db/repositories.js');
      vi.mocked(repo.cognitiveModuleLogRepo.record).mockClear();
      await runCognitiveModule(
        { name: 'test.no-context.skip-audit', triggered_by: 'sync_required' },
        async () => 'x',
      );
      // Regression: before #269 this branch wrote a row with
      // tenant_id='default', agent_id='default'. Now it must skip entirely.
      expect(repo.cognitiveModuleLogRepo.record).not.toHaveBeenCalled();
    });

    it('audit log is NOT written when ctx.tenant_id is empty string', async () => {
      const repo = await import('@/db/repositories.js');
      vi.mocked(repo.cognitiveModuleLogRepo.record).mockClear();
      await runWithTenantContext({ tenant_id: '', agent_id: 'sofia' }, async () => {
        await runCognitiveModule(
          { name: 'test.empty-tenant', triggered_by: 'sync_required' },
          async () => 'x',
        );
      });
      // tryGetCurrentContext now returns null for malformed ctx, so audit is
      // skipped — no row with the empty-string tenant should land.
      expect(repo.cognitiveModuleLogRepo.record).not.toHaveBeenCalled();
    });

    it('audit log is NOT written when ctx.agent_id is null', async () => {
      const repo = await import('@/db/repositories.js');
      vi.mocked(repo.cognitiveModuleLogRepo.record).mockClear();
      await runWithTenantContext(
        { tenant_id: 'acme', agent_id: null as unknown as string },
        async () => {
          await runCognitiveModule(
            { name: 'test.null-agent', triggered_by: 'sync_required' },
            async () => 'x',
          );
        },
      );
      expect(repo.cognitiveModuleLogRepo.record).not.toHaveBeenCalled();
    });

    it('audit log IS written with real tenant_id / agent_id when context is valid', async () => {
      const repo = await import('@/db/repositories.js');
      vi.mocked(repo.cognitiveModuleLogRepo.record).mockClear();
      await runWithTenantContext({ tenant_id: 'tenantX', agent_id: 'agentX' }, async () => {
        await runCognitiveModule(
          { name: 'test.valid-context', triggered_by: 'sync_required' },
          async () => 'x',
        );
      });
      expect(repo.cognitiveModuleLogRepo.record).toHaveBeenCalledTimes(1);
      const call = vi.mocked(repo.cognitiveModuleLogRepo.record).mock.calls[0]![0];
      expect(call.tenant_id).toBe('tenantX');
      expect(call.agent_id).toBe('agentX');
      // Regression guard: no fallback strings leak into the audit row.
      expect(call.tenant_id).not.toBe('default');
      expect(call.agent_id).not.toBe('default');
    });
  });

  // -------------------------------------------------------------------------
  // Issue #507 — CANCELAMENTO É ESTADO PRÓPRIO.
  //
  // O defeito: `runCognitiveModule` recebia `fn: () => Promise<T>` e só sabia
  // `Promise.race` com um timer. Um cancelamento do caller (na prática: a lease
  // do turno perdida no meio do round-trip do reasoner) não tinha como chegar à
  // operação subjacente NEM como aparecer no resultado. Os dois desfechos
  // possíveis eram ambos falsos:
  //   · o provedor terminava antes de qualquer um olhar o sinal, o `fn`
  //     resolvia, e a row de `cognitive_module_log` dizia `success` — auditoria
  //     afirmando que um turno que já não era nosso deu certo;
  //   · o `fn` rejeitava por outro motivo e caía no catch genérico como
  //     `error` + `fallback_triggered=true`, contaminando a taxa de fallback.
  //
  // Os casos abaixo fixam o contrato novo: o `fn` RECEBE o sinal composto, o
  // desfecho é `cancelled`, o fallback NÃO dispara, o resultado tardio é
  // DESCARTADO e a row de auditoria diz a verdade.
  // -------------------------------------------------------------------------
  /**
   * Achado 4 da revisão do dono na PR #599 — a métrica de cancelamento tem de
   * passar pela camada SANCIONADA.
   *
   * A emissão original chamava `src/lib/metrics.ts::incCounter` direto, com as
   * chaves `module`/`cause`. Três consequências, e as três são testadas aqui:
   *
   *   1. a série não recebia `tenant_id`/`agent_id` — não dava para atribuir o
   *      cancelamento ao tenant do turno (invariante #1 do AGENTS.md);
   *   2. `module`/`cause` nem estão em `ALLOWED_LABEL_KEYS`, então nada passava
   *      pelo guard de PII/forma;
   *   3. a alegação de cardinalidade fechada era falsa: o `procedure-selector`
   *      deriva o nome do módulo do NOME DO PROCEDIMENTO, que é dado de tenant.
   */
  describe('issue #507 achado 4 — a métrica de cancelamento é atribuída e limitada', () => {
    async function emitirCancelamento(
      name: string,
      escopo: { tenant_id: string; agent_id: string },
    ): Promise<void> {
      const ac = new AbortController();
      ac.abort('lease_lost');
      await runWithTenantContext(escopo, async () => {
        await runCognitiveModule(
          { name, triggered_by: 'sync_required', audit: false, signal: ac.signal },
          async () => 'x',
        );
      });
    }

    it('ATRIBUIÇÃO: a série carrega tenant_id + agent_id do turno', async () => {
      const metrics = await import('@/lib/metrics.js');
      const labels = await import('@/observability/labels.js');
      metrics._resetForTests();
      labels._resetLabelGuardForTests();

      await emitirCancelamento('reasoner', {
        tenant_id: 'tenant-507',
        agent_id: 'agent-507',
      });

      const exposicao = await metrics.renderPrometheus();
      const linha = exposicao
        .split('\n')
        .find((l) => l.startsWith('maia_cognitive_module_cancelled_total'));
      expect(linha, 'a série de cancelamento tem de ser emitida').toBeDefined();
      expect(linha).toContain('tenant_id="tenant-507"');
      expect(linha).toContain('agent_id="agent-507"');
      // As dimensões são as JÁ sancionadas — nenhuma chave nova na taxonomia.
      expect(linha).toContain('workload="reasoner"');
      expect(linha).toContain('reason="caller_already_aborted"');
      // E as chaves antigas, que não estão na allowlist, não sobrevivem.
      expect(linha).not.toContain('module=');
      expect(linha).not.toContain('cause=');
    });

    it('FORMA: um nome de módulo derivado de dado de tenant vira __sanitized__', async () => {
      const metrics = await import('@/lib/metrics.js');
      const labels = await import('@/observability/labels.js');
      metrics._resetForTests();
      labels._resetLabelGuardForTests();

      // Exatamente o que `src/cognition/procedure-selector.ts` monta:
      // `procedure-selector.${def.nome}` — e `def.nome` é texto do tenant.
      await emitirCancelamento('procedure-selector.Fechamento Mensal da Loja', {
        tenant_id: 'tenant-507',
        agent_id: 'agent-507',
      });

      const exposicao = await metrics.renderPrometheus();
      const linha = exposicao
        .split('\n')
        .find((l) => l.startsWith('maia_cognitive_module_cancelled_total'));
      expect(linha).toContain('workload="__sanitized__"');
      expect(linha, 'texto livre do tenant não pode virar label').not.toContain('Fechamento');
    });

    it('OVERFLOW: o budget por (métrica, chave) fecha a cardinalidade', async () => {
      const metrics = await import('@/lib/metrics.js');
      const labels = await import('@/observability/labels.js');
      const taxonomy = await import('@/observability/taxonomy.js');
      metrics._resetForTests();
      labels._resetLabelGuardForTests();

      const budget =
        taxonomy.LABEL_CARDINALITY_BUDGET['workload'] ??
        taxonomy.DEFAULT_LABEL_CARDINALITY_BUDGET;
      for (let i = 0; i <= budget + 1; i++) {
        await emitirCancelamento(`procedure-selector.proc-${i}`, {
          tenant_id: 'tenant-507',
          agent_id: 'agent-507',
        });
      }

      const exposicao = await metrics.renderPrometheus();
      const linhas = exposicao
        .split('\n')
        .filter((l) => l.startsWith('maia_cognitive_module_cancelled_total'));
      expect(
        linhas.some((l) => l.includes(`workload="${taxonomy.CARDINALITY_OVERFLOW_VALUE}"`)),
        'passado o budget, o excedente tem de colapsar no bucket de overflow',
      ).toBe(true);
      expect(
        linhas.length,
        'e o número de séries não pode crescer com o número de procedimentos',
      ).toBeLessThanOrEqual(budget + 1);
    });
  });

  describe('issue #507 — signal, cancelamento e resultado tardio', () => {
    /** Rejeição que um `fn` cooperativo produz ao ver o sinal abortar. */
    function abortError(): Error {
      const e = new Error('llm_call_aborted');
      e.name = 'AbortError';
      return e;
    }

    it('o fn RECEBE um AbortSignal mesmo quando o caller não passa nenhum', async () => {
      let received: unknown = 'não chamado';
      await runWithTenantContext({ tenant_id: 'tX', agent_id: 'aX' }, async () => {
        await runCognitiveModule(
          { name: 'test.507.recebe-sinal', triggered_by: 'sync_required' },
          async (signal) => {
            received = signal;
            return 'ok';
          },
        );
      });
      // Sem isto, um call site que escreve `(signal) => callLLM({ signal })`
      // passaria `undefined` adiante e o gateway não teria o que cancelar.
      expect(received).toBeInstanceOf(AbortSignal);
      expect((received as AbortSignal).aborted).toBe(false);
    });

    it('o timeout ABORTA o sinal entregue ao fn — não apenas vence o race', async () => {
      let observed: AbortSignal | null = null;
      await runWithTenantContext({ tenant_id: 'tX', agent_id: 'aX' }, async () => {
        const result = await runCognitiveModule(
          {
            name: 'test.507.timeout-aborta',
            triggered_by: 'sync_conditional',
            timeoutMs: 20,
            fallback: 'fb',
          },
          (signal) =>
            new Promise<string>((_, reject) => {
              observed = signal;
              signal.addEventListener('abort', () => reject(abortError()), { once: true });
            }),
        );
        // O vocabulário NÃO muda para quem não passou sinal: estourar o próprio
        // limite continua sendo `timeout` com fallback, não `cancelled`. Isto é
        // a regressão que o `timedOut` do runner protege — com o `fn` agora
        // cooperativo, a rejeição dele vence o race e, sem a flag, um estouro de
        // limite seria classificado como `error`.
        expect(result.status).toBe('timeout');
        expect(result.output).toBe('fb');
        expect(result.fallback_triggered).toBe(true);
      });
      expect(observed).not.toBeNull();
      expect(observed!.aborted).toBe(true);
      expect(observed!.reason).toBe('cognitive_module_timeout');
    });

    it('caller cancela DURANTE a chamada: status=cancelled, sem fallback', async () => {
      const ac = new AbortController();
      const fallbackFn = vi.fn(() => 'fb');
      await runWithTenantContext({ tenant_id: 'tX', agent_id: 'aX' }, async () => {
        const result = await runCognitiveModule(
          {
            name: 'test.507.cancel-durante',
            triggered_by: 'sync_required',
            timeoutMs: 5000,
            fallback: fallbackFn,
            signal: ac.signal,
          },
          (signal) =>
            new Promise<string>((_, reject) => {
              signal.addEventListener('abort', () => reject(abortError()), { once: true });
              setTimeout(() => ac.abort('lease_lost'), 5);
            }),
        );
        expect(result.status).toBe('cancelled');
        expect(result.output).toBeNull();
        // A distinção que o dono pediu: cancelamento NÃO é degradação de
        // produto. Marcar fallback aqui envenenaria a métrica que mede quanto o
        // usuário recebeu de resposta pior.
        expect(result.fallback_triggered).toBe(false);
      });
      expect(fallbackFn, 'o fallback não pode ser sintetizado num cancelamento').not.toHaveBeenCalled();
    });

    /**
     * Achado 3 da revisão do dono na PR #599.
     *
     * A versão anterior deste caso passava um `fn` que conferia
     * `signal.aborted` e lançava — ou seja, provava que o `fn` RECEBIA o sinal
     * abortado, não que ele deixava de ser CHAMADO. E era o contrário do que o
     * runner precisava garantir: `composeSignal` devolvia o sinal já abortado e
     * `fn(composed.signal)` era avaliado assim mesmo. O gateway de LLM tem
     * preflight próprio, então ReAct e pending-gate não abriam request — mas o
     * contrato deste runner é genérico, e um `fn` que ignora o sinal ficava
     * pendurado até o timeout inteiro prendendo o caller.
     *
     * As duas asserções são as que o dono pediu: `fn` NÃO chamado, e latência
     * sem avançar timer nenhum.
     */
    it('sinal JÁ abortado: o fn NEM É CHAMADO, e não se espera o timeout', async () => {
      const ac = new AbortController();
      ac.abort('lease_lost');
      const fn = vi.fn(async () => 'nunca deveria ter rodado');
      await runWithTenantContext({ tenant_id: 'tX', agent_id: 'aX' }, async () => {
        const t0 = Date.now();
        const result = await runCognitiveModule(
          {
            name: 'test.507.ja-abortado',
            triggered_by: 'sync_required',
            // Timeout GRANDE de propósito: se o runner invocasse o `fn` e
            // esperasse o race, um `fn` não cooperativo seguraria o caller por
            // este tempo todo. A latência abaixo é o que denuncia isso.
            timeoutMs: 30_000,
            fallback: 'fb',
            signal: ac.signal,
          },
          fn,
        );
        const decorrido = Date.now() - t0;

        expect(fn, 'o fn não pode ser invocado com o caller já cancelado').not.toHaveBeenCalled();
        expect(decorrido, 'nada pode esperar o timeout do módulo').toBeLessThan(1_000);
        expect(result.status).toBe('cancelled');
        expect(result.output).toBeNull();
        expect(result.fallback_triggered).toBe(false);
      });
    });

    it('sinal JÁ abortado: a causa auditada é caller_already_aborted', async () => {
      const repo = await import('@/db/repositories.js');
      vi.mocked(repo.cognitiveModuleLogRepo.record).mockClear();
      const ac = new AbortController();
      ac.abort('lease_lost');
      await runWithTenantContext({ tenant_id: 'tX', agent_id: 'aX' }, async () => {
        await runCognitiveModule(
          { name: 'test.507.ja-abortado.causa', triggered_by: 'sync_required', signal: ac.signal },
          async () => 'x',
        );
      });
      const row = vi.mocked(repo.cognitiveModuleLogRepo.record).mock.calls[0]![0] as {
        status: string;
        metadata: Record<string, unknown>;
      };
      expect(row.status).toBe('cancelled');
      // Distinta de `signal_aborted` de propósito: ali a perda aconteceu
      // DURANTE este módulo; aqui ela veio de um boundary a montante, e é isso
      // que a série de cancelamento precisa conseguir dizer.
      expect(row.metadata).toEqual({ cancel_cause: 'caller_already_aborted' });
    });

    it('RESULTADO TARDIO: o fn resolve depois do abort → output descartado', async () => {
      const ac = new AbortController();
      await runWithTenantContext({ tenant_id: 'tX', agent_id: 'aX' }, async () => {
        const result = await runCognitiveModule(
          {
            name: 'test.507.late-result',
            triggered_by: 'sync_required',
            timeoutMs: 5000,
            signal: ac.signal,
          },
          // Dependência NÃO cooperativa: ignora o sinal e entrega assim mesmo.
          // É o caso exato que o dono descreveu — o LLM RETORNA e a row saía
          // como `success` para um turno que já não era nosso.
          async () => {
            ac.abort('lease_lost');
            await new Promise((r) => setTimeout(r, 5));
            return 'resposta-cara-e-tardia';
          },
        );
        expect(result.status).toBe('cancelled');
        // Descartado, não devolvido: um resultado tardio não pode virar
        // resposta ao usuário nem mutação de estado.
        expect(result.output).toBeNull();
        expect(result.fallback_triggered).toBe(false);
      });
    });

    it('a row de auditoria diz cancelled + cancel_cause, e NÃO diz success', async () => {
      const repo = await import('@/db/repositories.js');
      vi.mocked(repo.cognitiveModuleLogRepo.record).mockClear();
      const ac = new AbortController();
      await runWithTenantContext({ tenant_id: 'tenantY', agent_id: 'agentY' }, async () => {
        await runCognitiveModule(
          { name: 'test.507.audit', triggered_by: 'sync_required', signal: ac.signal },
          async () => {
            ac.abort('lease_lost');
            return 'tardio';
          },
        );
      });
      expect(repo.cognitiveModuleLogRepo.record).toHaveBeenCalledTimes(1);
      const row = vi.mocked(repo.cognitiveModuleLogRepo.record).mock.calls[0]![0];
      expect(row.status).toBe('cancelled');
      expect(row.fallback_triggered).toBe(false);
      // `fallback_reason` só faz sentido ao lado de `fallback_triggered=true`;
      // a causa do cancelamento vai em metadata, com cardinalidade fechada.
      expect(row.fallback_reason).toBeNull();
      expect(row.metadata).toEqual({ cancel_cause: 'late_result_discarded' });
    });

    it('o listener no sinal do CALLER é removido em todos os caminhos', async () => {
      const ac = new AbortController();
      const addSpy = vi.spyOn(ac.signal, 'addEventListener');
      const removeSpy = vi.spyOn(ac.signal, 'removeEventListener');
      try {
        await runWithTenantContext({ tenant_id: 'tX', agent_id: 'aX' }, async () => {
          await runCognitiveModule(
            { name: 'test.507.listener-sucesso', triggered_by: 'sync_required', signal: ac.signal },
            async () => 'ok',
          );
          await runCognitiveModule(
            { name: 'test.507.listener-erro', triggered_by: 'sync_required', signal: ac.signal },
            async () => {
              throw new Error('boom');
            },
          );
        });
        // O sinal do caller vive o TURNO inteiro; a chamada, não. Sem o
        // `removeEventListener` cada módulo deixaria um listener (e o
        // controller que ele retém) pendurado até o fim do turno.
        expect(addSpy).toHaveBeenCalledTimes(2);
        expect(removeSpy).toHaveBeenCalledTimes(2);
      } finally {
        addSpy.mockRestore();
        removeSpy.mockRestore();
      }
    });

    it('REGRESSÃO: sem `signal`, nada muda — erro continua error + fallback', async () => {
      await runWithTenantContext({ tenant_id: 'tX', agent_id: 'aX' }, async () => {
        const result = await runCognitiveModule(
          { name: 'test.507.sem-signal', triggered_by: 'async_event', fallback: 'fb' },
          async () => {
            throw abortError();
          },
        );
        // Um `AbortError` vindo de outra fonte que não o sinal deste runner
        // continua sendo falha: `cancelled` é reservado a quem OPTOU por passar
        // o sinal, senão o vocabulário novo vazaria para os ~30 call sites que
        // não migraram.
        expect(result.status).toBe('error');
        expect(result.output).toBe('fb');
        expect(result.fallback_triggered).toBe(true);
      });
    });
  });

  // Issue #224 — regression: the Promise.race timeout handle must be cleared
  // on every exit path. Otherwise pending setTimeout handles accumulate in
  // the event loop, retain closures, and surface as "open handles" warnings
  // in tests. Sibling fix to the abort-listener cleanup in skill-runner.ts
  // (PR #221).
  describe('issue #224 — clearTimeout on race settle', () => {
    it('success path: clearTimeout is called after fn() resolves before timeout', async () => {
      const clearSpy = vi.spyOn(globalThis, 'clearTimeout');
      const setSpy = vi.spyOn(globalThis, 'setTimeout');
      try {
        await runWithTenantContext({ tenant_id: 'default', agent_id: 'default' }, async () => {
          await runCognitiveModule(
            { name: 'test.cleartimeout.success', triggered_by: 'sync_required', timeoutMs: 5000 },
            async () => 'fast',
          );
        });
        // The race installs exactly one setTimeout; clearTimeout must fire on
        // the same handle. We assert clearTimeout was invoked with one of the
        // handles returned by setTimeout — not just "any call" — to be sure
        // we're cleaning *the runner's* timer and not some unrelated one.
        const setHandles = setSpy.mock.results.map((r) => r.value);
        const clearedHandles = clearSpy.mock.calls.map((c) => c[0]);
        const matched = setHandles.some((h) => clearedHandles.includes(h));
        expect(matched).toBe(true);
      } finally {
        clearSpy.mockRestore();
        setSpy.mockRestore();
      }
    });

    it('error path: clearTimeout is called after fn() rejects before timeout', async () => {
      const clearSpy = vi.spyOn(globalThis, 'clearTimeout');
      const setSpy = vi.spyOn(globalThis, 'setTimeout');
      try {
        await runWithTenantContext({ tenant_id: 'default', agent_id: 'default' }, async () => {
          await runCognitiveModule(
            { name: 'test.cleartimeout.error', triggered_by: 'async_event', timeoutMs: 5000, fallback: null },
            async () => { throw new Error('boom'); },
          );
        });
        const setHandles = setSpy.mock.results.map((r) => r.value);
        const clearedHandles = clearSpy.mock.calls.map((c) => c[0]);
        const matched = setHandles.some((h) => clearedHandles.includes(h));
        expect(matched).toBe(true);
      } finally {
        clearSpy.mockRestore();
        setSpy.mockRestore();
      }
    });

    it('timeout path: clearTimeout is called even when the timeout wins the race', async () => {
      const clearSpy = vi.spyOn(globalThis, 'clearTimeout');
      const setSpy = vi.spyOn(globalThis, 'setTimeout');
      try {
        await runWithTenantContext({ tenant_id: 'default', agent_id: 'default' }, async () => {
          const result = await runCognitiveModule(
            { name: 'test.cleartimeout.timeout', triggered_by: 'sync_conditional', timeoutMs: 20, fallback: 'fb' },
            async () => new Promise((r) => setTimeout(() => r('slow'), 200)),
          );
          expect(result.status).toBe('timeout');
        });
        // After the timeout fires, the handle is already-dispatched but
        // clearTimeout is still called (no-op for fired handles). The
        // contract we're enforcing is "always clear", not "skip when fired".
        const setHandles = setSpy.mock.results.map((r) => r.value);
        const clearedHandles = clearSpy.mock.calls.map((c) => c[0]);
        const matched = setHandles.some((h) => clearedHandles.includes(h));
        expect(matched).toBe(true);
      } finally {
        clearSpy.mockRestore();
        setSpy.mockRestore();
      }
    });
  });
});
