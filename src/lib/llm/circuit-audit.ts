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
 * Chave de `metadata` que carrega a identidade da RÉPLICA (achado 4 da
 * re-review do owner na PR #541). Exportada porque o consumidor — a regra
 * `llm_circuit_long_open` de `src/workers/audit-watcher.ts` — correlaciona por
 * ela, e produtor e consumidor concordarem "por acaso" sobre o nome de uma
 * chave JSONB é exatamente como um alerta volta a ficar cego em silêncio.
 */
export const REPLICA_METADATA_KEY = 'replica';

let cachedReplica: string | null = null;

/**
 * Identidade da réplica que observou a transição.
 *
 * ## Por que a trilha PRECISA disto
 *
 * O estado do disjuntor é por `(provider, workload)` (`circuit-breaker.ts`,
 * `keyOf`) **e por processo**: a janela deslizante de amostras vive na memória
 * de cada réplica, e nada a compartilha. Duas réplicas atrás do mesmo balanço
 * podem estar, ao mesmo tempo, uma com `anthropic/reasoner` aberto e a outra
 * com ele fechado — e as duas estão certas sobre o que enxergam.
 *
 * Sem esta chave, `llm_circuit_opened` e `llm_circuit_closed` são
 * indistinguíveis entre circuitos e entre réplicas, e a regra de "stuck" casa
 * QUALQUER fechamento posterior com QUALQUER abertura: um circuito que abriu e
 * fechou normalmente desarma o alerta de outro que continua preso aberto. O
 * alerta fica cego exatamente no cenário que existe para pegar.
 *
 * ## Por que `<host>:<pid>#<boot>` e não só `<host>:<pid>`
 *
 * `runtimeInstanceId()` é `<hostname>:<pid>`, legível e consistente com as
 * leases do repo — é o que responde "QUAL container?" numa investigação. Mas
 * ele NÃO é único no tempo: em container, o processo principal é PID 1 e o
 * hostname é estável, então `host:1` se repete a cada restart. Um processo
 * novo herdaria a identidade do morto e o `closed` dele fecharia a abertura
 * que o processo anterior deixou em aberto — a mesma correlação cruzada que
 * esta chave existe para eliminar, só que mais difícil de ver.
 *
 * `lifecycle.instanceId` é sorteado por processo (#512), então o sufixo torna
 * a identidade única por BOOT sem custar a legibilidade do prefixo.
 *
 * ## O que isto assume, e o que não conserta
 *
 * Uma réplica que MORRE com o circuito aberto nunca emite o `closed` do par:
 * aquela abertura fica sem fechamento e a regra alerta por ela enquanto a
 * linha estiver na janela de 24 h do watcher. Isso é ruído CONHECIDO e
 * deliberado — o inverso (deixar o boot seguinte fechar o par) é o defeito
 * original. O runbook operacional diz ao plantão como reconhecer o caso: se a
 * réplica citada no alerta não existe mais, cruze com
 * `maia_llm_circuit_state{state="open"}`, que só existe para processo vivo.
 */
function replicaIdentity(): string {
  cachedReplica ??= `${runtimeInstanceId()}#${lifecycle.instanceId}`;
  return cachedReplica;
}

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
      // A identidade da réplica entra AQUI, e não no `detail` de
      // `circuit-breaker.ts`/`circuit-mode.ts`, para que TODA ação desta
      // trilha a carregue por construção — inclusive as que forem
      // adicionadas depois. Vai por último de propósito: nenhum caller pode
      // sobrescrever a própria identidade com um valor de metadado.
      metadata: { ...metadata, [REPLICA_METADATA_KEY]: replicaIdentity() },
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
  replicaIdentity,
};
