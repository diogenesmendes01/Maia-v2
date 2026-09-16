# AGENT-REPORT-P06 — gateway de inferência, custo e egresso

> Fatia de **CONTRATO + POLÍTICA PURA**. Branch `claude/mh-p06-gateway`, base
> `7993e563`. Commits LOCAIS, sem push/merge/deploy, sem migration aplicada,
> **sem nenhuma chamada paga a provider**.
>
> Seções citadas são de `SPEC-IMPLEMENTACAO-MAIA-HERMES.md`.

## 0. O que esta fatia NÃO é

Declarado antes de tudo, para que nada aqui seja lido como mais do que é:

- **não há servidor, rota Fastify ou cliente HTTP.** A rota `POST
  /internal/hermes-inference/v1/chat/completions` do §9.1 existe neste código
  como **constante e schema**, não como endpoint que atende;
- **não há repositório, migration ou tabela.** As quatro estruturas NOVAS do
  §9.2 (`engine_inference_grants`, `engine_budget_accounts`,
  `engine_inference_attempts`, `engine_usage_events`) **não existem** — ver §7;
- **não há provider.** Nenhuma fixture desta fatia é resposta de LLM real; todas
  são sintéticas e escritas à mão nos specs;
- **nenhum teste toca Postgres, Redis ou rede.** Isso é propriedade verificada,
  não promessa: os casos 43/44 e 36/37/38 leem o FONTE como texto e reprovam
  import de `@/db/`, `@/lib/redis`, `@/config/`, `@/lib/logger`, `@/lib/metrics`,
  `drizzle`, `ioredis`, e reprovam relógio de processo.

## 1. O que implementei, e em quais commits

| Commit | Entrega |
|---|---|
| `309abf2e` | `src/integrations/hermes/inference-gateway.ts` — contrato do PEDIDO (schema Zod estrito, campos admitidos do §9.1, campos de autoridade recusados por nome), vocabulário de erro do §9.1 com status HTTP, `toWireError` sanitizado, e `validateInferenceGrant` (T18). Spec `tests/unit/hermes-inference-gateway-contract.spec.ts` |
| `58e7fe97` | `src/integrations/hermes/cost-accounting.ts` (dobra idempotente de eventos de uso) e `src/integrations/hermes/cost-reservation.ts` (decisão de admissão sob limite). Spec `tests/unit/hermes-cost-accounting.spec.ts` |
| `c93dc128` | Reforço de 3 casos que a verificação por mutação provou fracos — ver §4 |
| `9f5063d3` | Schema estrito da RESPOSTA + `parseInferenceResponse` (§9.1 itens 8 e 9). Eu havia entregue só metade do contrato pedido ("pedido **e** resposta") |

**As garantias estruturais**, que são o que de fato defendo:

1. **K-09 vira recusa verificável.** Parâmetro desconhecido falha com
   `unsupported_parameter` *antes* de encaminhar, e não é ignorado. `user`,
   `metadata`, session id e ids de escopo são recusados **por nome** — mesmo
   desenho com que `protocol.ts:306-320` recusa `api_key` dentro de `inference`.
2. **T18 é indistinguível no fio.** Grant ausente, audience errada e grant
   expirado colapsam no mesmo `invalid_inference_grant`. O motivo real vive em
   `audit_reason`, que **não** viaja no corpo — distinguir responderia "este run
   existe?" a quem não apresentou credencial.
3. **A ausência é o mecanismo.** `InferenceRequestContextV1` não tem
   `pessoa_id`/`conversa_id`/`channel_id`/`remote_jid`: "nenhuma consulta
   business" não depende de alguém lembrar de não consultar, depende do tipo não
   conseguir expressar o dado. Idem em `cost-reservation.ts`, onde não existe
   membro que signifique "teto de fatura".
4. **Zero nunca é fabricado.** `cost=null` não vira `0`; `usage` ausente vira
   `null`; reserva sem preço é `null` e não `'0'`; fold sem eventos é `reserved`
   e não `settled`. Dinheiro é `microusd` inteiro somado em `BigInt`, exato acima
   de 2^53.

## 2. Matriz §11.2 — teste a teste

Critério aplicado: **não marco COBERTO o que depende de banco, de servidor ou de
provider real.** Por isso não há nenhum "COBERTO" pleno abaixo — esta fatia é,
por construção, a metade pura de cada caso.

| Caso | Situação | O que está coberto | A metade que FALTA |
|---|---|---|---|
| **T18** | **PARCIAL** | Grant ausente/expirado/audience errada → recusa sanitizada e indistinguível (401); revogado → `run_revoked` (403); autenticação **antes** de qualquer código que afirme algo sobre o run; motivo de auditoria separado do corpo; corpo sem ids/audience/instante; instante ILEGÍVEL falha fechada (`NaN` não vira "não expirou") | "**Canal inválido**" — a autenticação de TRANSPORTE (posse da conexão/credencial restrita, §6.10 item 7) não existe: é do supervisor (P07). E o *lookup* do grant pela hash da credencial é banco. Minha função recebe o grant **já resolvido** |
| **T56** | **PARCIAL** | Falha com possível cobrança **não zera custo**: exposição estimada sobrevive; stream parcial sem usage vira `unknown` (não zero); evidência nova ajusta por evento compensatório sem apagar a cobrança original; três tentativas cobradas somam as três (§6.10 item 5) | "**Retry limitado**" não é exercitado: é comportamento do relay (§9.1 item 7, "sem retry oculto no relay"), e não há HTTP nesta fatia. Nenhum 429/stream parcial REAL foi observado — os eventos são sintéticos |
| **T57** | **PARCIAL** | Evento repetido conta uma vez; a dobra é comutativa e estável sob N repetições; mesmo `event_id` com conteúdo divergente é conflito explícito, nunca overwrite silencioso (§9.2) | A idempotência DURÁVEL (unique de `event_id` em `engine_usage_events`) não existe — hoje a garantia só vale dentro da dobra pura. E a regra de dashboard do §9.2 ("**proibir somar as duas projeções** do mesmo request") não foi implementada nem testada |
| **T58** | **PARCIAL** | A decisão de admissão sob limite: 10 pedidos de 30 com teto 100 admitem **3**; reservado **e** liquidado contam juntos; fronteira exata (exposição == limite admite, +1 recusa); store indisponível recusa; `guarantee: 'admission_only'` em TODA decisão | **A ATOMICIDADE não está verificada.** Meu teste modela a serialização que o lock do §9.2 imporia — ele não prova que duas transações concorrentes serializam. Isso exige Postgres e a tabela `engine_budget_accounts`. Também não modelei `period_start_utc` nem a virada do dia UTC |
| **T59** | **PARCIAL** | `estimated`/`unknown` são estados visíveis e `unknown` domina; zero SEM evidência é `reserved`, nunca `settled`; zero COM evidência do provider liquida (a régua é a evidência, não o número); `usage` ausente na resposta vira `null`, nunca zeros | O gatilho "lookup de preço falha" é **modelado** (`delta=null`, `estimate=null`), não exercitado: não existe tabela de tarifa versionada, e a tarifa real da casa vive em `cost-ledger.ts`, que não posso tocar (ver C25) |

### Gate G-COST — **NÃO ATINGIDO**

O gate real é o §6.12 item 11: "gateway fake registra cada chamada principal, SDK
retry e compressão/auxiliar; reserva esgotada bloqueia **antes do provider**; uso
ausente vira unknown. Depois teste pequeno com provider real autorizado."

Desse enunciado esta fatia entrega **apenas** a política de "uso ausente vira
unknown" e a regra de "reserva esgotada recusa". O gateway fake, a cobertura das
rotas auxiliares/compressão e o teste com provider real **não existem** — os dois
primeiros precisam do servidor (fora de escopo), o terceiro é D02 com orçamento
não autorizado. Não marque G-COST como atingido com base neste relatório.

## 3. Gates executados — exit codes reais

Capturados na hora, com `cmd > arquivo 2>&1; echo $?`, **sem pipe para `tail`**.
Node `v22.23.2`.

| Gate | Comando | Exit |
|---|---|---|
| Typecheck | `npx tsc --noEmit` | **0** |
| Lint | `npx eslint` nos 5 arquivos desta fatia | **0** |
| Unit | `npx vitest run tests/unit/hermes-inference-gateway-contract.spec.ts tests/unit/hermes-cost-accounting.spec.ts --no-coverage` | **0** |

Resultado do runner, na íntegra: `executados=100 falharam=0 **pulados=0**` — 61
casos no spec do gateway e 39 no de custo. Nenhum `describe.skip`, nenhum teste
pulado: pulado não é passou.

**Vermelho legítimo registrado antes de cada implementação**, como exigido:
`EXIT=1` com `Cannot find package '@/integrations/hermes/cost-accounting.js'` e
`.../inference-gateway.js` (primeira leva) e `EXIT=1` com
`TypeError: parseInferenceResponse is not a function` × 7 (schema da resposta).

`prettier` **não** foi executado: não é gate neste repo (não há configuração, e
705 arquivos de `src/` reprovariam) — rodá-lo criaria churn em arquivo alheio.

## 4. Verificação por mutação

**44 mutantes distintos escolhidos À MÃO, 44 mortos** (45 aplicações, contando um
mutante de controle re-executado). Os três últimos (M42–M44) **não são meus**:
vieram da revisão independente desta fatia — ver o achado 4, que é o mais
importante da lista.

**Mais 35 mutantes GERADOS POR OPERADOR**, depois que o achado 4 provou que
mutante escolhido à mão cobre só o que o autor já suspeita. O gerador aplica, uma
ocorrência por vez a partir do fonte original, ` && `↔` || `, `>=`→`>`, `<=`→`<` e
`===`↔`!==`: 22 em `inference-gateway.ts` (19 mortos), 7 em `cost-accounting.ts`
(7 mortos) e 6 em `cost-reservation.ts` (6 mortos) — os dois módulos de custo até
então só tinham mutantes escolhidos à mão.

**Os 3 sobreviventes foram classificados um a um, e nenhum é garantia:** dois são
`issue?.path.join('.') || 'body'`, rótulo do campo de erro (a revisão provou por
mutação COMBINADA que trocar os dois juntos não quebra a suíte, como deve), e o
terceiro é a guarda de tipo do corpo na L303, redundante com a validação do Zod
logo abaixo. Mutar rótulo não prova nada — por isso são absolvidos explicitamente
em vez de contados como cobertura. Cada mutante quebra deliberadamente UM predicado que
sustenta uma garantia; "morto" = algum caso falhou.

| Alvo | Mutantes | Resultado |
|---|---|---|
| Schema do pedido / K-09 | M01–M06 | 6 mortos |
| Grant / T18 | M07–M17 | 11 mortos |
| `cost-accounting` / T56-T57-T59 | M18–M26 | 9 mortos (M23 só depois do reforço) |
| `cost-reservation` / T58 | M27–M36 | 10 mortos |
| Schema da resposta | M37–M41 | 5 mortos |
| Guarda de instante ilegível (`expirou`) | M42–M44 | 3 mortos — **achados pela revisão**, não por mim |
| Pares tool_call/tool_result (§9.1 val. 3) | 4 sítios novos | 4 mortos, dentro do sweep por operador |
| Sweep por OPERADOR, arquivo inteiro (3 arquivos) | 35 gerados | 32 mortos + 3 sobreviventes classificados e absolvidos |

**Os três achados honestos desta varredura** — o valor dela está aqui, não no
placar:

1. **M23 SOBREVIVEU** ("delta negativo aceito fora de `adjustment`"). O caso 19
   original passava um único evento `reported: '-10'`, e nesse input a guarda de
   **total** negativo cobria a ausência da guarda **por evento**: dois predicados,
   um só caso. Corrigi o TESTE (não a asserção): acrescentei
   `[reported '100', reported '-10']`, onde o total fica em 90 e só a guarda do
   evento pode recusar. M23 passou a morrer, e um mutante de controle (M24bis)
   confirmou que a guarda de total continua com o seu próprio caso. Commit
   `c93dc128`.
2. **M36 e M41 não chegaram a rodar** na primeira tentativa — âncoras minhas com
   indentação errada (`ANCORA_INVALIDA(0)` e `(2)`). Reexecutados com âncora
   única, ambos morreram. Registro porque **um mutante que não aplica não é
   evidência de nada**, e contá-lo como morto teria inflado o placar.
3. **Duas lacunas foram fechadas ANTES da varredura**, por inspeção do desenho:
   campo de autoridade agora é cobrado pelo `reason: 'reserved_authority'` (sem
   isso, apagar a checagem devolvia o mesmo código pela checagem de campo
   desconhecido) e o teto de tools passou a exigir `payload_too_large` (com só
   "invalid", o `.max()` do Zod recusava por outro caminho e o mutante
   sobrevivia).

4. **A varredura da revisão achou o que a minha não olhou.** Os meus 41 mutantes
   foram escolhidos À MÃO, e nenhum deles tocou `expirou()`
   (`inference-gateway.ts:446-451`). Uma varredura independente gerada por
   OPERADOR (`&&`↔`||`, `>=`→`>`, `===`→`!==`) encontrou a guarda de fail-closed
   **sem cobertura nenhuma**: remover a guarda INTEIRA sobrevivia, apesar de seis
   casos do spec exercitarem `expires_at`. O código estava CERTO — o defeito era
   de cobertura. Mas sem cobertura nada impediria um refactor de apagá-la, e a
   consequência seria grave: `Date.parse` de data corrompida é `NaN`, `NaN > fim`
   é `false`, e um grant inválido passaria como **válido** — recusa autenticada
   virando aceite, o oposto exato do que o T18 cobra. Corrigido em `5736e296`
   com três casos (28b-d), um para cada metade do `||` e um para o conjunto; com
   a guarda removida os três falham e os outros 52 continuam passando.
   **Lição registrada:** mutante escolhido à mão cobre o que o autor já suspeita;
   mutante gerado por operador cobre o que ele não pensou em olhar.

**Redundância deliberada, nomeada:** o `.strict()` do objeto de topo do pedido é
inalcançável, porque a varredura de chaves roda antes e sempre recusa primeiro.
Fica como rede de segurança para uma reordenação futura — a carga é provada por
mutação COMBINADA (desligar a varredura *e* o `.strict()` mata os casos 5-7),
mesmo padrão que o P03.7b já registrou para pares redundantes.

## 5. O que NÃO verifiquei, e por quê

- **Nada contra Postgres ou Redis.** A fatia é pura por construção e as tabelas
  do §9.2 não existem. Nenhuma migration foi escrita nem aplicada.
- **Nenhuma chamada a provider.** Proibido nesta sessão e sem orçamento
  autorizado (D02). Nenhuma resposta de mock é apresentada como resposta real.
- **Não subi servidor nem testei a rota.** Fora do escopo declarado desta fatia.
- **Não rodei a suíte completa (`npm test`) nem `npm run lint` inteiro.** Rodei
  os dois specs desta fatia e o eslint nos cinco arquivos, como instruído.
  Portanto **não afirmo** nada sobre regressão no resto do repositório — o que
  posso afirmar é que `tsc --noEmit`, que é global, passou com exit 0.
- **`stream: true` não é exercitado de ponta a ponta.** O schema aceita o campo
  (o §9.1 o admite), mas o modo inicial da resposta é não-streaming e o buffering
  de metadados que o item 8 exige não existe — é do relay.

## 6. Contradições e decisões registradas

Continuo a numeração de `IMPLEMENTATION-STATE.md`, que vai até C22. **Não editei
aquele arquivo** (é compartilhado); estas entradas ficam aqui para serem
transcritas por quem o mantém.

**C23 — D09 continua ABERTA, e o schema é da SPEC, não do cliente pinado.**
O §9.1 manda "capturar o request real do SHA fixado e fechar JSON Schema
explícito", e admite "`max_tokens` **ou o campo de limite realmente emitido pelo
cliente fixado**" (linha 2529). A captura **não foi feita** — é D09. Implementei
`max_tokens`, que é o nome que a spec grafa, e **não inventei** alias de outro
SDK. Consequência honesta: o gate de compatibilidade do §9.1 continua aberto, e
um cliente que emita outro nome de campo será recusado com
`unsupported_parameter` — o que é o comportamento correto, mas significa que a
coorte não pode ser habilitada antes da captura. Decisão minha adjacente:
`stream_options` é nomeado pelo §9.1 **sem forma**, e modelei
`{ include_usage: boolean }` pela convenção do chat completions.

**C24 — dois orçamentos com postura de falha OPOSTA, e a divergência é
normativa.** O §9.2 exige fail-closed ("Store indisponível => nenhuma inferência
nova"). O orçamento legado da Maia falha **aberto**: `src/lib/llm/budget.ts`
(cabeçalho: "Redis INDISPONÍVEL → fail-OPEN") devolve `noReservation()` no
`catch` da reserva. O próprio §9.2 diz que a mudança "altera somente o caminho
Hermes; **não modificar silenciosamente o fail-open Maia legado**". Implementei
fail-closed em `cost-reservation.ts` e **não toquei** em `budget.ts`. Registro
porque duas políticas opostas convivendo é exatamente o que um leitor futuro
"uniformiza" sem saber que a divergência foi decidida.

**C25 — unidade de dinheiro divergente; K-18 segue bloqueado.** O ledger
existente soma `usd_cents` como `numeric` arredondado a 2 casas dentro do
`ON CONFLICT DO UPDATE` (`src/lib/cost-ledger.ts:164-177`) e `readDailyLLMUsd`
devolve USD em float (`:190-195`). O §9.2 exige `microusd` **inteiro** não
negativo. São duas unidades e duas aritméticas para o mesmo conceito. A
integração de dashboard que o §9.2 pede — "acrescentar agregação Hermes
idempotente a `readDailyLLMUsd`… **proibir somar as duas projeções** do mesmo
request" — **não foi feita e não podia ser**: `cost-ledger.ts` está na minha lista
de arquivos proibidos. K-18 continua bloqueado, agora com a incompatibilidade de
unidade nomeada além do `ON CONFLICT`.

**C26 — pares tool_call/tool_result: metade implementada, metade DEFERIDA.** O
§9.1 validação 3 manda "validar … **pares de tool call/result**". Isso é
invariante CRUZADA entre mensagens, que o schema por mensagem não alcança.

> **STATUS (atualizado após a revisão).** A metade "para frente" — todo
> `tool_call_id` de uma mensagem `role:'tool'` corresponde a um `tool_calls[].id`
> de um `assistant` **anterior** — foi autorizada na revisão e está implementada
> em `99845c94`, com 6 casos novos e cobertura confirmada por sweep de operador.
>
> A metade "para trás" — `tool_calls[].id` do assistant que fica sem resposta —
> **continua deferida**, e a omissão é a decisão. Responder a ela exigiria saber
> se um pedido pode legitimamente carregar uma call ainda pendente, e isso é
> semântica de sequenciamento do §5.7.4 itens 4-5 (piloto sequencial, uma call
> pendente por run, callback adiantado devolvendo `in_progress`). A leitura
> plausível — "o cliente não emitiria nova inferência com uma call em aberto" —
> viraria decisão sem procedência, que é o erro que o C18 obrigou a corrigir no
> P03. Fica para o P07, quando o sequenciamento for fixado. Pela mesma régua, id
> anunciado duas vezes ou respondido duas vezes toca a redelivery do §5.7.4 item
> 3 e também não é julgado.
>
> Numeração **deliberadamente inalterada**: o remapeamento C23–C27 → C28–C32 é da
> integração, não meu.

**C27 — o §9.1 não dá código de erro para resposta do PROVIDER malformada.** A
lista de erros do §9.1 é toda sobre o pedido do cliente. Escolhi
`provider_unavailable` (503) para forma inválida — o pedido do filho estava
correto, e 400 ensinaria o cliente a "corrigir" um pedido sem defeito — e
`tool_surface_mismatch` (403) para tool devolvida fora da superfície. **Decisão
minha**, não leitura da spec.

## 7. O que preciso nos arquivos compartilhados que não pude tocar

Nada abaixo foi editado por mim. São pedidos, com a razão.

1. **`migrations/**` + `src/db/schema.ts`** — as quatro estruturas do §9.2 não
   existem. Preciso, especificamente:
   - `engine_usage_events` com **unique de `event_id`** por escopo. Hoje a
     idempotência do T57 só existe dentro da minha dobra pura; sem a unique, dois
     processos gravam o mesmo evento duas vezes e a dobra soma certo um dado
     errado;
   - `engine_budget_accounts` com `row_version` (o CAS que `applyAdmission`
     pressupõe) e `microusd` como inteiro **não negativo** (BIGINT/NUMERIC sem
     casas), não `numeric(…,2)` de USD;
   - `engine_inference_grants` com **unique do hash** da credencial e sem coluna
     de texto do token (§9.2 "nunca texto do token");
   - `engine_inference_attempts` com `accounting_status`, cujo vocabulário eu já
     fixei em `ACCOUNTING_STATUSES` (`reserved|estimated|settled|unknown`) — vale
     conferir antes de a DDL escolher outro.
2. **`src/governance/audit-actions.ts`** — **não há ação de auditoria para recusa
   de grant/admissão**. Produzo `audit_reason` (`absent`, `audience_mismatch`,
   `expired`, `revoked`, `model_not_allowed`, `manifest_mismatch`,
   `tool_not_in_manifest`, `call_cap_reached`) exatamente para ser auditado, e
   hoje não existe rótulo onde gravá-lo. É o mesmo problema que o C22 registrou
   para o P04; se o P04 for acrescentar ações, vale acrescentar as do gateway na
   mesma leva.
3. **`src/lib/cost-ledger.ts`** — a agregação idempotente do dashboard e a
   unidade de dinheiro (C25 / K-18).
4. **`src/runtime/engines/contracts.ts`** — **nenhuma mudança necessária**. Só
   importei `EngineRunPhaseV1` (leitura), e a política acompanha automaticamente
   se o P02 alterar a união de fases.

## 8. Estado sugerido para `REQUIREMENTS-MATRIX.md` (não editei)

Para quem mantém o arquivo compartilhado:

- **K-09** → "implementado não verificado" na metade de CONTRATO
  (`inference-gateway.ts`); o enforcement real depende do servidor e do supervisor;
- **T18, T56, T57, T58, T59** → **parcial**, com a metade que falta descrita em §2;
- **G-COST** → permanece **não iniciado/não atingido** (§2);
- **K-18** → permanece **bloqueado**, agora também por unidade de dinheiro (C25);
- **D09** → permanece **aberta** (C23). Não foi fechada por suposição.
