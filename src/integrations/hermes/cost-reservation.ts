/**
 * P06 (spec §9.2, §6.10 item 6; gate G-COST; T58) — a RESERVA de limite como
 * política PURA.
 *
 * ─── A frase que este arquivo torna executável ─────────────────────────────
 *
 * §9.2, transação de admissão: "lock de conta(s) + grant/run necessários na
 * ordem definida; revalidar autoridade/limites; calcular exposição conservadora
 * com tarifa versionada conhecida; inserir tentativa e somar reserva; commit.
 * Nenhuma TX aberta durante provider HTTP. **Store indisponível => nenhuma
 * inferência nova**."
 *
 * E o limite do T58, que é o ponto do caso: "Reserva atômica controla o limite
 * de admissão; **nenhuma promessa indevida de hard cap real**".
 *
 * ─── O que esta função É e o que ela NÃO É ─────────────────────────────────
 *
 * É a DECISÃO que a transação de admissão toma depois de travar a conta. Não é
 * a transação, não é o lock, não é a tabela. A atomicidade vem do banco (§9.2);
 * o que mora aqui é a regra que o banco aplica sob lock, e mantê-la pura é o que
 * permite exercitar admissões concorrentes sem Postgres — a serialização que o
 * lock impõe vira, no teste, a dobra de decisões sobre a conta que evolui.
 *
 * ─── Por que `guarantee` viaja em TODA decisão ─────────────────────────────
 *
 * Porque o §9.2 é explícito sobre o limite do que se pode prometer: "pode-se
 * garantir teto da admissão/exposição segundo preços e limites conhecidos, **não
 * um valor final absoluto da fatura externa** sem contrato e medição do
 * provedor". Um chamador que lesse `admit` como "o gasto está limitado" estaria
 * lendo mais do que existe. O campo torna a modéstia parte do tipo, em vez de
 * uma observação no relatório que ninguém lê no call site.
 */

/**
 * A garantia que esta política oferece, e o nome é o teto da promessa: controla
 * ADMISSÃO. Não há membro que signifique "teto de fatura" — a ausência é o
 * mecanismo, como em `RECOVERY_DISPOSITIONS`.
 */
export const ADMISSION_GUARANTEE = 'admission_only' as const;

export type AdmissionGuarantee = typeof ADMISSION_GUARANTEE;

/**
 * `engine_budget_accounts` (§9.2), na forma que a decisão precisa: conta por
 * `(tenant_id, agent_id, period_start_utc)` já resolvida e travada.
 *
 * Não há `tenant_id` aqui: quem resolveu a conta foi o repositório, sob ALS. A
 * política não escolhe conta — escolher conta a partir de um parâmetro é como se
 * constrói um caminho cross-tenant sem querer.
 */
export interface BudgetAccountV1 {
  limit_microusd: string;
  reserved_microusd: string;
  settled_microusd: string;
  row_version: number;
}

export interface AdmissionRequestV1 {
  /**
   * Exposição conservadora desta tentativa. `null` quando a tarifa versionada
   * não é conhecida — e `null` NÃO é zero, pelo mesmo motivo do §9.2.
   */
  estimate_microusd: string | null;
  /** Inclui retries e auxiliares (§9.3 `MAIA_HERMES_MAX_INFERENCE_CALLS`). */
  calls_so_far: number;
  max_inference_calls: number;
}

/**
 * O que fazer quando não há preço verificável.
 *
 * §9.2: "sem preço/limite superior verificável, modo de hard cap fica
 * desabilitado **ou** a admissão é negada conforme policy". A spec deixa os dois
 * caminhos abertos, então a escolha entra por PARÂMETRO — exatamente como
 * `blockCategories` em `poison-policy`. Fixá-la aqui dentro seria política
 * minha disfarçada de leitura da spec.
 */
export interface AdmissionPolicyV1 {
  on_unpriced: 'deny' | 'admit_unpriced';
}

export type AdmissionDecisionV1 =
  | {
      kind: 'admit';
      guarantee: AdmissionGuarantee;
      /** `null` = admitida SEM preço. Nunca `'0'`: zero seria exposição falsa. */
      reserve_microusd: string | null;
      /** Falso quando não há tarifa: o teto não pode ser imposto sem preço. */
      hard_cap_enabled: boolean;
    }
  | {
      kind: 'refuse';
      guarantee: AdmissionGuarantee;
      code: 'budget_exhausted' | 'inference_limit_exceeded' | 'admission_unavailable';
    };

const DECIMAL_UINT_RE = /^(0|[1-9][0-9]*)$/;

function uint(valor: string, campo: string): bigint {
  if (!DECIMAL_UINT_RE.test(valor)) {
    throw new TypeError(`${campo}: precisa ser inteiro decimal não negativo em string (§9.2)`);
  }
  return BigInt(valor);
}

/**
 * Decide a admissão desta tentativa. Função TOTAL.
 *
 * A ORDEM é parte da regra:
 *
 *  1. **store indisponível** primeiro — §9.2 em letras: "Store indisponível =>
 *     nenhuma inferência nova". É o oposto do fail-open do orçamento legado da
 *     Maia (`src/lib/llm/budget.ts`, que degrada aberto em falha de Redis), e a
 *     diferença é deliberada: o §9.2 diz que o caminho Hermes não herda aquela
 *     política, e manda não alterar a legada em silêncio;
 *  2. **teto de chamadas** antes do orçamento, porque é limite de execução e não
 *     financeiro — o §9.1 lhe dá código próprio (`inference_limit_exceeded`), e
 *     colapsá-lo em `budget_exhausted` faria o operador procurar dinheiro onde o
 *     problema é contagem;
 *  3. **orçamento** por último, com a exposição já reservada E a já liquidada
 *     contando juntas: reservado é dinheiro que pode virar fatura, e ignorá-lo
 *     é o check-then-act que o §9.2 existe para eliminar.
 */
export function decideAdmission(
  account: BudgetAccountV1 | null,
  request: AdmissionRequestV1,
  policy: AdmissionPolicyV1,
): AdmissionDecisionV1 {
  if (account === null) {
    return { kind: 'refuse', guarantee: ADMISSION_GUARANTEE, code: 'admission_unavailable' };
  }

  if (request.calls_so_far >= request.max_inference_calls) {
    return { kind: 'refuse', guarantee: ADMISSION_GUARANTEE, code: 'inference_limit_exceeded' };
  }

  if (request.estimate_microusd === null) {
    if (policy.on_unpriced === 'deny') {
      return { kind: 'refuse', guarantee: ADMISSION_GUARANTEE, code: 'budget_exhausted' };
    }
    // Admitida sem preço: a reserva é `null` (não zero) para que a ausência de
    // tarifa fique VISÍVEL na conta, e o hard cap é declarado desligado —
    // impor teto sem preço seria afirmar um controle que não existe.
    return {
      kind: 'admit',
      guarantee: ADMISSION_GUARANTEE,
      reserve_microusd: null,
      hard_cap_enabled: false,
    };
  }

  const estimativa = uint(request.estimate_microusd, 'estimate_microusd');
  const limite = uint(account.limit_microusd, 'limit_microusd');
  const exposicao =
    uint(account.reserved_microusd, 'reserved_microusd') +
    uint(account.settled_microusd, 'settled_microusd') +
    estimativa;

  if (exposicao > limite) {
    return { kind: 'refuse', guarantee: ADMISSION_GUARANTEE, code: 'budget_exhausted' };
  }

  return {
    kind: 'admit',
    guarantee: ADMISSION_GUARANTEE,
    reserve_microusd: estimativa.toString(),
    hard_cap_enabled: true,
  };
}

/**
 * Aplica uma admissão à conta — a metade "soma reserva" da transação do §9.2.
 *
 * `row_version` avança em TODA admissão, inclusive na não precificada: a
 * tentativa existe, e uma versão que não anda deixaria um CAS concorrente
 * acreditar que nada aconteceu. A exposição, essa sim, só anda quando há preço.
 */
export function applyAdmission(
  account: BudgetAccountV1,
  decision: AdmissionDecisionV1,
): BudgetAccountV1 {
  if (decision.kind !== 'admit') return account;
  const reservado = uint(account.reserved_microusd, 'reserved_microusd');
  const acrescimo =
    decision.reserve_microusd === null
      ? 0n
      : uint(decision.reserve_microusd, 'reserve_microusd');
  return {
    ...account,
    reserved_microusd: (reservado + acrescimo).toString(),
    row_version: account.row_version + 1,
  };
}
