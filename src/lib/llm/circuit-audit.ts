/**
 * Trilha DURÁVEL do disjuntor de LLM — achado 2 da revisão adversarial da PR
 * #541 (issue #534).
 *
 * ## O buraco que este arquivo fecha
 *
 * A taxonomia (`src/governance/audit-actions.ts`) já declarava
 * `llm_circuit_opened` / `llm_circuit_closed`, e o watcher de auditoria
 * (`src/workers/audit-watcher.ts`, regra `llm_circuit_long_open`) já procurava
 * exatamente esse par para alertar "circuito aberto há mais de 5 minutos".
 * Só que `grep -rn "audit(" src/lib/llm/` devolvia ZERO: as transições do
 * disjuntor e os overrides do kill switch emitiam apenas Prometheus + log
 * estruturado. O alerta durável estava MORTO — um consumidor sem produtor.
 *
 * Duas consequências, e nenhuma é cosmética:
 *
 *  1. O alerta de plantão nunca dispararia, e o silêncio dele era
 *     indistinguível de "nada aconteceu".
 *  2. Mudança de postura com `actor` / `reason` (quem virou o kill switch, e
 *     por quê) vivia só no log estruturado, que tem retenção curta e cai junto
 *     com o coletor. O invariante 4 do `AGENTS.md` ("toda decisão de
 *     governança vira linha em `audit_log`") exige durabilidade, não log.
 *
 * ## Por que TUDO aqui roda em `runWithSystemContext`
 *
 * A `ADR 0002` (`docs/architecture/decisions/0002-external-dependency-health-is-system-state.md`)
 * classifica saúde de dependência externa compartilhada como estado
 * operacional `system`, fora da regra 1 do `AGENTS.md`, sob quatro condições
 * cumulativas. A transição do disjuntor as satisfaz todas:
 *
 *  1. não deriva de dado de tenant (é contagem de falha de um serviço externo);
 *  2. o provider é o mesmo para todo mundo (uma chave de processo);
 *  3. só falha ATRIBUÍVEL AO PROVIDER alimenta a janela (`PROVIDER_FAULT_KINDS`);
 *  4. cada CONSEQUÊNCIA continua atribuída — a recusa individual sai em
 *     `maia_llm_requests_total{status="circuit_open"}` com `tenant_id +
 *     agent_id`, e isto aqui não substitui aquilo.
 *
 * Daí o `runWithSystemContext` EXPLÍCITO em vez do fallback automático de
 * `audit()`: a transição acontece dentro da chamada de algum tenant, então sem
 * o wrapper a linha herdaria o `tenant_id` de quem por acaso estava em voo
 * quando o disjuntor virou. Isso seria uma MENTIRA de atribuição — o estado é
 * da frota, não daquele tenant —, e é o mesmo raciocínio que já governa o
 * `attribute: false` do contador de override em `circuit-mode.ts`.
 *
 * ## A armadilha do `alvo_id` (já custou um buraco silencioso nesta PR)
 *
 * `audit_log.alvo_id` é **UUID** (`migrations/001_initial.sql`), e o "alvo"
 * natural aqui é o par `(provider, workload)` — TEXT. Passar texto num uuid faz
 * o INSERT estourar, e `audit()` engole a falha por design (log + contador,
 * sem propagar): a linha sumiria em silêncio e o alerta continuaria morto,
 * agora com um produtor que parece existir. Por isso o alvo vai em
 * `entidade_alvo` (TEXT) + `metadata` (JSONB), e `alvo_id` fica NULO.
 *
 * ## A identidade da RÉPLICA, e por que ela é parte do alvo
 *
 * (achado 4 da RE-REVISÃO do owner na PR #541.)
 *
 * O disjuntor é estado **em memória**, chaveado por `(provider, workload)`
 * (`circuit-breaker.ts`, `keyOf`) — e portanto **por processo**: cada réplica
 * tem a própria janela, o próprio cooldown e o próprio estado. Duas réplicas
 * podem estar honestamente discordando sobre o mesmo par no mesmo instante.
 *
 * A regra `llm_circuit_long_open` do `audit-watcher.ts` casa um
 * `llm_circuit_opened` com o `llm_circuit_closed` que vem depois. Sem saber de
 * QUEM é cada linha, ela casava linhas de circuitos diferentes: um par que
 * abriu e fechou normalmente desarmava o alerta de outro par que continuava
 * preso aberto — o alerta ficava cego exatamente no cenário que existe para
 * pegar. `provider` e `workload` já iam no metadata; a identidade da réplica
 * não, e sem as três o alvo não é único.
 *
 * `runtimeInstanceId()` (`<hostname>:<pid>`) é a mesma identidade que a posse
 * de linha WhatsApp já usa (`src/runtime/instance-identity.ts`), e não
 * `lifecycle.instanceId` (UUID aleatório): o operador que recebe o alerta
 * precisa saber QUAL container está com o disjuntor preso, não um id opaco.
 *
 * Vai em `metadata` (JSONB), NUNCA em label Prometheus: `hostname:pid` é
 * cardinalidade sem teto e `instance_id` não está — nem deve estar — em
 * `ALLOWED_LABEL_KEYS` (#514). No Prometheus a mesma distinção já existe de
 * graça: cada réplica expõe a própria série `maia_llm_circuit_state`, separada
 * pelos labels de target que o scraper adiciona.
 *
 * ## Por que import dinâmico
 *
 * `@/governance/audit.js` puxa `@/db/repositories.js` → `@/db/client.js`, que
 * **abre um pool de Postgres na importação**. O disjuntor é hot path e é
 * importado por specs que não têm banco nenhum; um import estático criaria
 * pool (e handle aberto) em todos eles. Transição de disjuntor e virada de
 * kill switch são eventos RAROS — resolver o módulo no momento do evento custa
 * nada e mantém o caminho quente sem dependência de banco.
 *
 * ## Por que fire-and-forget, e como ela ainda não se perde
 *
 * `transition()` e `auditOverride()` são síncronos e estão no caminho de uma
 * chamada de LLM: bloquear neles um INSERT põe a latência do Postgres na
 * frente do provider, que é exatamente a falha correlacionada que o disjuntor
 * existe para sobreviver. A escrita é disparada e não esperada — mas não fica
 * invisível:
 *
 *  - registrada em `lifecycle.trackBackgroundTask('llm_circuit_audit', …)`,
 *    então o DRENO de shutdown a aguarda dentro do orçamento de graça (#512).
 *    Um processo que morre com a transição em voo perderia justamente o evento
 *    que o plantão precisa;
 *  - rastreada localmente para `drainCircuitAudits()`, que é o que permite ao
 *    teste provar que a LINHA chegou em vez de dormir um tempo arbitrário.
 */
import { logger } from '@/lib/logger.js';
import { lifecycle } from '@/runtime/lifecycle/controller.js';
import { runtimeInstanceId } from '@/runtime/instance-identity.js';
import type { AuditAction } from '@/governance/audit-actions.js';

/** Ações desta trilha. Todas existem em `AUDIT_ACTIONS` (typecheck garante). */
export type CircuitAuditAction = Extract<
  AuditAction,
  | 'llm_circuit_opened'
  | 'llm_circuit_closed'
  | 'llm_circuit_mode_override_applied'
  | 'llm_circuit_mode_override_cleared'
  | 'llm_circuit_mode_override_expired'
  | 'llm_circuit_mode_override_rejected'
>;

/**
 * Escritas em voo. `Set` e não contador: o dreno precisa AGUARDAR cada uma,
 * não só saber quantas existem.
 */
const pending = new Set<Promise<void>>();

async function writeCircuitAudit(
  acao: CircuitAuditAction,
  metadata: Record<string, unknown>,
): Promise<void> {
  const [{ audit }, { runWithSystemContext }] = await Promise.all([
    import('@/governance/audit.js'),
    import('@/db/tenant-context.js'),
  ]);
  await runWithSystemContext(() =>
    audit({
      acao,
      // TEXT, não `alvo_id` (uuid). Ver o bloco "armadilha" acima.
      entidade_alvo: 'llm_circuit',
      // `instance_id` por ÚLTIMO de propósito: é a identidade da réplica e
      // nenhum chamador pode sobrescrevê-la sem querer. Ver o bloco
      // "identidade da réplica" no topo do arquivo.
      metadata: { ...metadata, instance_id: runtimeInstanceId() },
    }),
  );
}

/**
 * Registra uma decisão do disjuntor na trilha durável, sem bloquear o caller.
 *
 * Nunca lança: uma falha de auditoria não pode derrubar a chamada de LLM que a
 * originou. Ela vira log de erro — `audit()` já emite
 * `maia_audit_write_failed_total` no caminho dele.
 */
export function recordCircuitAudit(
  acao: CircuitAuditAction,
  metadata: Record<string, unknown>,
): void {
  const p = writeCircuitAudit(acao, metadata).catch((err: unknown) => {
    logger.error(
      { err: (err as Error)?.message, acao },
      'llm_gateway.circuit_audit_failed',
    );
  });
  // O drain de shutdown (#512) aguarda o que estiver registrado aqui.
  void lifecycle.trackBackgroundTask('llm_circuit_audit', p);
  pending.add(p);
  void p.finally(() => pending.delete(p));
}

/**
 * Aguarda as escrituras de auditoria em voo desta camada.
 *
 * O dreno de produção é o do lifecycle (ver `recordCircuitAudit`); este existe
 * para o TESTE: o padrão de verificação desta PR exige provar que a LINHA
 * chegou no `audit_log`, não que a função foi chamada, e sem um ponto de espera
 * o teste viraria um `sleep` arbitrário — verde por acidente de timing.
 *
 * O laço, e não um `Promise.all` único, é deliberado: uma escritura pode
 * disparar outra (`effectiveMode()` percebendo um override vencido dentro do
 * caminho de auditoria), e sair com a segunda ainda em voo devolveria a mesma
 * corrida que este dreno existe para eliminar.
 */
export async function drainCircuitAudits(): Promise<void> {
  while (pending.size > 0) {
    await Promise.all([...pending]);
  }
}

/** Test seam: quantas escritas ainda estão em voo. */
export const _internal = {
  pendingCount: (): number => pending.size,
};
