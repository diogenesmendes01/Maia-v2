/**
 * Re-review do PR #541, achado 1 [High] — o PREDICADO que decide quem é o dono
 * da ativação de uma linha.
 *
 * O teste dirige o executor (um duplo do `select` do drizzle) para provar duas
 * coisas que a integração não isola bem: o par COMPLETO entra no filtro, e os
 * estados TERMINais são excluídos — sem isso, uma run concluída (`active`)
 * congelaria o pareamento de recovery de #518 para sempre.
 */
import { describe, it, expect, vi } from 'vitest';
import { resolveLineActivationOwner } from '../../../src/setup/line-activation-owner.js';
import { TERMINAL_STATES } from '../../../src/onboarding/state-machine.js';

type Captured = { columns: unknown; where: unknown; limit: number | null };

function fakeExecutor(rows: Array<{ id: string; state: string }>): {
  executor: { select: (cols: unknown) => unknown };
  captured: Captured;
} {
  const captured: Captured = { columns: null, where: null, limit: null };
  const executor = {
    select: (columns: unknown) => {
      captured.columns = columns;
      return {
        from: () => ({
          where: (w: unknown) => {
            captured.where = w;
            return {
              limit: (n: number) => {
                captured.limit = n;
                return Promise.resolve(rows);
              },
            };
          },
        }),
      };
    },
  };
  return { executor, captured };
}

/**
 * Os literais que o predicado do drizzle carrega. O objeto é cíclico
 * (`PgTable` ↔ `PgColumn`), então a varredura leva um `seen` — `JSON.stringify`
 * explode nele.
 */
function literalsOf(node: unknown, seen = new Set<unknown>()): string[] {
  if (typeof node === 'string') return [node];
  if (node === null || typeof node !== 'object') return [];
  if (seen.has(node)) return [];
  seen.add(node);
  return Object.values(node as Record<string, unknown>).flatMap((v) => literalsOf(v, seen));
}

const SCOPE = { tenant_id: 'tenant-A', agent_id: 'agent-a' };

describe('resolveLineActivationOwner', () => {
  it('sem run viva: o dono é o pareamento (#518) — o caminho legado segue intacto', async () => {
    const { executor } = fakeExecutor([]);
    expect(await resolveLineActivationOwner(SCOPE, executor as never)).toEqual({
      owner: 'line_pairing',
    });
  });

  it('com run viva: o dono é a saga, e o veredito carrega a run para a trilha', async () => {
    const { executor, captured } = fakeExecutor([{ id: 'run-7', state: 'channel_ready' }]);
    expect(await resolveLineActivationOwner(SCOPE, executor as never)).toEqual({
      owner: 'onboarding_saga',
      run_id: 'run-7',
      run_state: 'channel_ready',
    });
    // Uma linha basta para decidir: não é uma listagem.
    expect(captured.limit).toBe(1);
  });

  it('o filtro cita o par COMPLETO (tenant + agente) e exclui TODOS os estados terminais', async () => {
    const { executor, captured } = fakeExecutor([]);
    await resolveLineActivationOwner(SCOPE, executor as never);
    const literals = literalsOf(captured.where);
    expect(literals).toContain('tenant-A');
    expect(literals).toContain('agent-a');
    for (const terminal of TERMINAL_STATES) {
      expect(literals).toContain(terminal);
    }
    // O vocabulário vem da máquina de estados, não de literais copiados aqui:
    // se um estado terminal novo aparecer, ele entra sozinho.
    expect([...TERMINAL_STATES].sort()).toEqual(['active', 'cancelled', 'failed_terminal']);
  });

  it('produção usa `db` por default (o executor é injeção só de teste)', () => {
    expect(resolveLineActivationOwner.length).toBe(1);
    expect(vi.isMockFunction(resolveLineActivationOwner)).toBe(false);
  });
});
