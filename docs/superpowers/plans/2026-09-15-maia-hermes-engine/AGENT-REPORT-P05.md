# AGENT-REPORT-P05 — contrato + política pura do broker

> Fatia entregue: **manifest, superfície efetiva e ACL de recurso/cliente**, como
> módulos PUROS. Branch `claude/mh-p05-broker`, base `7993e563`. Commits LOCAIS,
> sem push, sem merge, sem migration.
>
> **O que esta fatia NÃO é:** não há dispatcher, não há chamada a handler, não há
> acesso a banco e não há fiação no `core.ts`. Nenhuma linha de produção importa
> estes módulos ainda — eles compilam, são testados e estão inertes. Ler este
> relatório como "P05 entregue" seria erro de leitura: o P05 do capítulo 10 pede
> "binding por canal, manifest efetivo, ACL cliente/recurso, **dispatch
> instrumentado, receipt real**", e as duas últimas não estão aqui.

## 1. O que foi implementado, e em quais commits

| Commit | Arquivo | O que é |
|---|---|---|
| `3edb9420` | `src/integrations/hermes/manifest.ts` (+ `tests/unit/hermes-manifest-contract.spec.ts`, 31 casos) | O manifest `maia-hermes-runtime-manifest/v1` do §4.2 como schema Zod estrito, com default VAZIO, recusa tipada de `maia_*`/`mcp:*`/`all`/`*` (K-19) e o deny inicial do §7.10.3 |
| `37db0361` | `src/integrations/hermes/run-binding.ts` (+ `tests/unit/hermes-run-binding.spec.ts`, 21 casos) | A tupla do §6.4.1 validada e congelada recursivamente, a comparação de correlação de frame (§6.3) e a ACL de recurso com ids aninhados (§6.9.1 item 5) |
| `5424f676` | `src/integrations/hermes/tool-broker.ts` (+ `tests/unit/hermes-tool-broker-policy.spec.ts`, 36 casos) | A interseção do INV-03/§7.10.1 e a decisão de admissão por chamada na ordem do §6.9.1 |
| `989355eb` | `run-binding.ts` + `tool-broker.ts` (+ os dois specs, 6 casos novos) | **Correção de fail-open achada na revisão** (§3.1): estourar o teto de profundidade passou a RECUSAR — `too_deep` na triagem de argumentos, `scan_truncated` na ACL — em vez de devolver "nada encontrado" |

Total: **94 casos unitários**, todos executados (0 pulados). Nenhum arquivo
existente do repositório foi modificado — a fatia é inteiramente aditiva.

### Decisões de desenho que valem revisão

1. **As negações do §4.2 são `z.literal(true)`, não `z.boolean()`.** Com booleano,
   um compilador de manifest com defeito poderia emitir `mcp: false` e LIGAR a
   capacidade com o manifest continuando válido. Com literal, a única coisa que
   "desligar a negação" produz é manifest inválido. Mesmo mecanismo do
   `definitely_not_accepted: z.literal(true)` em `schemas.ts:329`.
2. **`effect_class` do manifest NÃO é nullable**, ao contrário da coluna
   `engine_tool_calls.effect_class` (migration 140). §4.1: "null NUNCA autoriza
   handler". A coluna aceita null porque uma call ainda não classificada existe;
   um manifest com null seria ferramenta habilitada sem semântica de
   cancelamento. **Não "consertar" a divergência igualando à coluna.**
3. **Falha de lookup FECHA a superfície** — inversão deliberada frente a
   `runtime-filter.ts:132-147`. Ver contradição C-P05-4.
4. **`approval_required` é `defer`, não recusa.** Ver contradição C-P05-2.
5. **`approval_mode: none|single|dual`** é vocabulário MEU: o §4.2 pede "modo de
   aprovação" e não enumera valores. Os três espelham o que a casa executa
   (`approval_requested`, `dual_approval_*` em `audit-actions.ts`). Não inventei
   um valor "auto", que seria aprovação sem humano.

## 2. Gates executados — exit code capturado na hora

| Gate | Comando | Exit | Resultado |
|---|---|---|---|
| Vermelho inicial (TDD) | `npx vitest run <3 specs>` | **1** | 3 arquivos não carregaram (módulos inexistentes); 0 casos executados |
| Vermelho da revisão (§3.1) | `npx vitest run <3 specs>` | **1** | 4 falharam / 90 passaram — vermelho de COMPORTAMENTO (`'ok'` onde tem de ser `'reject'`, `'allow'` onde tem de ser `'deny'`) |
| Typecheck | `npx tsc --noEmit` | **0** | sem saída |
| Lint | `npx eslint <6 arquivos>` | **0** | sem achados (uma reprovação real no caminho: `no-fallthrough` por comentário entre rótulos de `case`) |
| Testes | `npx vitest run <3 specs> --no-coverage` | **0** | **94 passaram**, 0 falharam, **0 pulados** |
| Varredura de mutação | 59 mutantes | **0** | 59 aplicados, **58 mortos**, **1 sobrevivente previsto e documentado** (N07), 0 erros de harness |

Node `v22.23.2` conferido antes de cada rodada. `prettier` não foi executado:
não há configuração no repositório e `npm run format` (= `prettier --write src`)
produziria churn em arquivo alheio — a decisão já está registrada em
IMPLEMENTATION-STATE §8.

### Uma reprovação legítima, e o que ela consertou

A primeira rodada verde deu **86/88 com 2 vermelhos**, e os dois eram defeito do
meu TESTE, não do código: a varredura de pureza lia o arquivo inteiro como texto
(o padrão de `engine-recovery-policy.spec.ts`) e reprovava por causa da PROSA —
o cabeçalho de `manifest.ts` cita `@/config/env.js` e o de `tool-broker.ts` cita
`_dispatcher.ts:300-324` justamente para dizer que NÃO os importam. Varrer texto
não distingue acoplamento de citação, e a citação é load-bearing.

Corrigi o TESTE para **mais preciso**, não para mais frouxo: a varredura passou a
ler só os especificadores de import, com um `expect(imports.length)
.toBeGreaterThan(0)` para que uma regex quebrada não aprove tudo em silêncio. Os
mutantes M20/M32/M52 (import proibido de `drizzle-orm` em cada módulo) provam que
a versão corrigida ainda morde.

## 3. Varredura de mutação — 59 aplicados, 58 mortos

Harness em `scratchpad/p05-mutantes.mjs`: recusa aplicar mutante cujo texto não
ocorra exatamente uma vez, restaura o original mesmo quando o vitest quebra, e a
árvore ficou limpa ao fim (`git status` vazio — os arquivos voltaram
byte-idênticos aos commits).

Cobertura da varredura, por garantia:

- **K-19** (M01-M05, M08): cada uma das quatro regras de nome reservado desligada
  isoladamente, mais a troca `startsWith`→`includes` (que barraria
  `consulta_maia_interna`, nome legítimo), mais a regra deixando de olhar
  `maia_tool_name`;
- **deny §7.10.3** (M06, M07, M38): desligado no manifest, deixando de olhar o
  nome interno, e deixando de valer na superfície;
- **campos que autorizam** (M11-M14, M19): `effect_class` nullable,
  `output_projection_id` opcional, `audit_action` virando string livre,
  `denies.mcp` virando boolean, `required_actions` fora de `ACTION_KEYS`;
- **T19** (M23-M26, M44): comparação desligada, recusa ecoando o id do outro run,
  ausência virando divergência, e catálogo respondendo antes da identidade;
- **T24/G-AUTH** (M27-M30, M46): ACL vazia deixando de recusar, pertencimento não
  checado, id aninhado invisível, seletor virando heurística;
- **INV-03** (M33-M39): interseção virando passagem livre, lookup falho virando
  eixo ignorado, role/skill ausente virando "sem narrowing", `baseline_only`
  dispensando qualquer eixo, denies e reservados sobrevivendo;
- **T20** (M40-M43): reservado invisível em profundidade, declarar o campo
  legalizando-o, campo fora do schema aceito, e `pessoa_id` virando reservado (o
  par: um seletor legítimo passando a morrer);
- **ordem do §6.9.1** (M44, M49): catálogo antes da identidade, aprovação antes da
  triagem de argumentos;
- **T29/T30/INV-10** (M47, M48, M51) e **código de wire inventado** (M50);
- **profundidade** (N01-N07, acrescentados na revisão — ver §3.1): as duas
  mutações por OPERADOR nos tetos (`>` → `>=`, N01/N04) e as quatro que
  RESTAURAM o fail-open (N02, N03, N05, N06) morrem todas.

### O sobrevivente, e por que ele fica

**N07 SOBREVIVEU**, e eu o declarei como previsto **antes** de rodar a varredura.
Ele troca o rótulo do truncamento em `decideToolCall`
(`acl.reason === 'scan_truncated' ? 'too_deep' : 'resource_out_of_acl'`) por
`'resource_out_of_acl'` fixo. Nenhum teste morre porque o ramo é **inalcançável
por construção**: os dois tetos valem 16, e `screenToolArgs` varre o mesmo objeto
ANTES da ACL, então todo payload capaz de truncar a varredura de recursos já foi
recusado como `too_deep` no passo anterior.

Mantive o ternário em vez de simplificá-lo, e a razão é o próprio defeito desta
revisão: se um dia os dois tetos divergirem, o ramo passa a ser alcançado, e sem
ele a recusa diria "este recurso não é seu" quando a verdade é "não enxerguei o
payload inteiro" — afirmando uma decisão de pertencimento que ninguém tomou. O
ramo é testado onde ele É alcançável: direto na API de `run-binding.ts` (caso
13c), que é módulo próprio e tem outros consumidores além do broker.

**Dois casos de teste nasceram da varredura, escritos ANTES de rodá-la**, por eu
ter previsto o sobrevivente ao mapear as mutações:

- caso **26b** do manifest: `canonicalDigest(manifest.tools)` passaria nos casos
  25 e 26 e faria dois manifests com LIMITES diferentes terem a mesma identidade —
  o `manifest_digest` do binding deixaria de detectar troca de orçamento ou de
  prazo. O mutante M18 morre por causa dele;
- caso **6b** do broker: sem ele, apagar o filtro de `INITIAL_TOOL_DENY` de dentro
  da interseção não quebrava nada — o deny só estava provado na porta do manifest,
  e a superfície é alimentada por seis outros eixos. O mutante M38 morre por causa
  dele.

### 3.1 O defeito de fail-open achado na revisão

A minha varredura escolhia os mutantes **à mão**, e é aí que ela é cega: eu mutei
os predicados que sabia estarem sustentando uma garantia. A revisão rodou uma
varredura por **OPERADOR** (`&&`↔`||`, `>=`→`>`, `===`→`!==`), que não depende do
que o autor acha que importa — e ela achou o que a minha não acharia.

**O defeito.** Os dois varredores recursivos tratavam o teto de profundidade como
condição de PARADA silenciosa:

```
screenToolArgs(['dados'], <tenant_id aninhado a N niveis>)
  N=16 -> reject reserved_argument      N=17 -> {"kind":"ok"}   <-- PASSAVA
collectResourceRefs(<entidade_id de outro cliente a N niveis>)
  N=16 -> [ref]                         N=17 -> []              <-- INVISIVEL
```

`encontraChaveReservada` devolvia `string | null`, e `null` significava ao mesmo
tempo "varri tudo e está limpo" e "desisti". `collectResourceRefs` devolvia lista
vazia, que o chamador lê como "não há recurso a autorizar". **Fail-OPEN nos dois
invariantes que esta fatia existe para sustentar** — e agravado por uma
composição que eu mesmo escrevi: a peneira de campo desconhecido só olha o TOPO,
então uma chave **declarada** (`dados`) carregando `tenant_id` no fundo
atravessava as duas peneiras.

**Por que o meu teste não pegou.** Meu caso de aninhamento (13) usava três
níveis. Ele provava que a recursão EXISTE; não provava nada sobre o que acontece
no limite dela. Um teste que exercita o meio de uma faixa não diz nada sobre a
borda — e é sempre na borda que a postura fail-open se esconde.

**A correção é de POSTURA, não de teto.** Subir o limite teria o mesmo defeito
mais fundo. O teto continua existindo (protege a pilha); o que mudou é o que
acontece ao alcançá-lo:

- `encontraChaveReservada` devolve `{clean|found|too_deep}` — três estados, e o
  tipo não consegue mais confundir "limpo" com "desisti";
- `screenToolArgs` recusa com `too_deep`, novo membro de
  `BROKER_REFUSAL_REASONS` mapeado em `protocol_error` — nome que o P00 já usa
  para o mesmo fato no wire (`WireErrorCode`), então **nenhum código novo** foi
  inventado no protocolo;
- `collectResourceRefs` devolve `ResourceScanV1 {refs, truncated}` e
  `authorizeResourceRefs` recusa `scan_truncated` **antes** de qualquer
  pertencimento. A varredura e a decisão viajam juntas de propósito: se a lista
  viajasse sozinha, o fail-closed dependeria de cada call site lembrar de
  conferir o truncamento — e um que esquecesse reproduziria o defeito.

**Faixa explorável, registrada:** o teto daqui (16) é mais estrito que o do wire
(`WIRE_LIMITS.max_json_depth`, 32). Existia portanto uma faixa — 17 a 32 — em que
o frame passava no P00 e esta varredura desistia calada. Hoje ela recusa.

**Efeito nos vereditos:** T20 e T24 estavam marcados **COBERTO** no meu relatório
original, e essa afirmação era **prematura** — "morre em qualquer profundidade"
era literalmente falso acima do teto. Só passou a valer com esta correção.

## 4. Critério de aceite — caso a caso do §11.2

Régua usada: **COBERTO** = a obrigação da coluna "Resultado obrigatório" é
executada por código desta fatia e um mutante prova que o teste morde, sem ponto
de enforcement faltando na MINHA camada. **PARCIAL** = parte da obrigação exige
outra camada (banco, dispatcher, saída, auditoria).

| Caso | Veredito | O que está coberto / o que falta |
|---|---|---|
| **T19** binding de A com frame de B | **PARCIAL** | Coberto: a comparação (§6.3), a recusa carregando só o CAMPO (nunca o id de B), e a ordem que faz a identidade responder antes do catálogo — senão a recusa vira oráculo de existência. **Falta: a auditoria.** Estes módulos não emitem `audit()` (são puros, por desenho), e o canal real (posse do pipe) é P06/P07. O enunciado pede "recusa **e auditoria**" |
| **T20** `tenant_id`/`pessoa_id`/`approved` fora do schema | **COBERTO** (política) — **desde a revisão** | Campo de autoridade morre em qualquer profundidade e **mesmo declarado no schema**; acima do teto de profundidade a triagem RECUSA (`too_deep`) em vez de desistir; campo fora do schema é recusado; o contexto vem só do binding. **Ressalva honesta:** este veredito era PREMATURO na primeira versão deste relatório — acima de 16 níveis o campo reservado passava (§3.1). A metade do wire já era do P00. Residual de P06: a construção do `ToolContext` (§6.9.1 item 4) |
| **T21** tool fora do manifest | **COBERTO** (política) | O eixo `manifest` é termo da interseção e o teste usa `remember_safe_fact`, que existe DE VERDADE no `baseline.core` da casa (`src/tools/grant-math.ts:114`). A segunda linha de defesa (o dispatcher) é P06 |
| **T22** grant revogado após admissão | **PARCIAL** | Coberto: a superfície é recomputada a cada chamada a partir dos eixos recebidos, então a **próxima tool** é bloqueada (INV-04: grants atuais prevalecem sobre snapshot). **Falta: "e saída final"** — o bloqueio do egresso é P06/P07 — e a releitura real de `capabilities_revoked_at` no banco |
| **T23** falha de lookup de grant/contexto | **COBERTO** (política) | Qualquer um dos sete eixos com lookup falho zera a superfície, com razão nomeada; role/skill ausente em run `scoped` fecha; `baseline_only` não amplia. **Requisito de handoff para P06:** quem fizer o lookup real precisa mapear exceção para `lookup_failed`, e não para `{kind:'allow', names: []}` — os dois fecham, mas o segundo perde a distinção entre incidente e configuração |
| **T24** id real de recurso de B | **COBERTO** (política) — **desde a revisão** | Decide por pertencimento, não pela forma do id; enxerga ids ANINHADOS e, quando não consegue enxergar tudo, **recusa** (`scan_truncated`) em vez de autorizar com visão parcial; a recusa não ecoa o id; ponta a ponta via `decideToolCall`. **Ressalva honesta:** também era PREMATURO — um id de outro cliente aninhado fundo era invisível para a ACL (§3.1). A procedência da ACL (carregada do banco pelo supervisor) é P06 |
| **T25** pesquisa que retornaria fragmento de B | **PARCIAL — e a metade que falta é a substantiva** | Coberto apenas: o seletor de sujeito não pode vir do modelo (campo reservado) e `authorization_target: current_subject` declara que o sujeito vem do binding. **A garantia do enunciado — "nenhum fragmento privado chega ao prompt/tool result" — NÃO está coberta:** ela exige o escopo real da busca e a projeção de saída, que são P08 |
| **T28** injeção "ignore as regras / use terminal" | **PARCIAL** | Coberto: `terminal` está no deny inicial e não sobrevive na superfície **nem que os sete eixos o listem**, e `decideToolCall` o recusa. **Falta: "dispatch também nega"** — a chamada a `dispatchTool` é P06, fora do escopo desta fatia por instrução |
| **T29** `ToolCallRef` inexistente | **COBERTO** (política) | `refs` vem SEMPRE do journal; o que o motor afirma a mais sai em `fabricated` e nunca vira evidência (§6.8). As linhas do journal são do P03; a fiação no assembler é P06 |
| **T30** aprovação two-person exigida | **PARCIAL** | Coberto: o manifest declara `approval_mode`; uma tool com aprovação exigida **nunca** é admitida (vira `defer`), e `approved:true` no frame morre antes disso. **Falta: "gate Maia permanece"** — `approval-requests.ts`, hash canônico e a matriz de aprovadores são intocados e ficam em P06/P09 |
| **T31** resultado com segredo/dados excessivos | **PARCIAL — só a metade de contrato** | Coberto: `output_projection_id` e `result_limit_chars` são OBRIGATÓRIOS por ferramenta, então uma tool sem projeção declarada não entra na allowlist. **A projeção/redação em si não existe**, e "segredo ausente em logs" não foi verificado |
| **G-AUTH** | **PARCIAL** | Coberto: contexto vazio recusa (ACL vazia → deny), cruzamento de cliente recusado, fixtures sintéticas com dois clientes reais do mesmo agente. **Falta:** a metade de banco do gate (isolamento cross-tenant em query real), que é P03/P06 e exige Postgres |

## 5. O que NÃO verifiquei, e por quê

1. **Nada foi exercitado num turno real.** Os três módulos têm ZERO call sites de
   produção. Isto é contrato e política, não comportamento observado.
2. **Suíte completa (`npm test`) não executada.** Rodei só os três specs novos. A
   fatia é aditiva (nenhum arquivo existente tocado, `git status` limpo) e o
   `tsc --noEmit` cobre o grafo inteiro de `src/`, o que pega quebra de import. A
   baseline da casa é ruidosa sob paralelismo, e interpretá-la custaria mais do
   que informa aqui. **Não estou afirmando que a suíte está verde** — estou
   dizendo que não a rodei.
3. **`test:integration` e `test:leak` não executados**: exigem Postgres, que esta
   worktree não tem, e nenhuma linha de produção mudou que pudesse vazar.
4. **Nada do §11.3** (motor real, provider, subprocesso): fora da fatia.
5. **`authorization_target` é declarado mas não enforçado** por ninguém ainda —
   ver C-P05-7. Declarar o campo não constrói o branch de autorização.
6. **A varredura de mutação por operador não é minha** — foi a revisão que a
   rodou, e foi ela que achou o fail-open do §3.1. A minha escolhe mutantes à
   mão e, por construção, não cobre o predicado que o autor não suspeitou. As
   duas são complementares, e eu não rodei a por operador nesta fatia.
7. **O teto de profundidade agora RECUSA payload legítimo acima de 16 níveis.**
   É deliberado e fail-closed, mas é uma mudança de comportamento para quem
   montar args muito aninhados: a recusa é `too_deep`, não "campo inválido".

## 6. Contradições entre spec e código real

| ID | Contradição | Referências | Tratamento |
|---|---|---|---|
| **C-P05-1** | **O K-19 recusa `maia_*`, e a fixture compartilhada do P00 usa exatamente isso.** `maia_fixture_echo` é o nome de tool em `tests/fixtures/hermes-wire/frames.json` — a fixture com md5 idêntico ao espelho Python — e em `hermes-wire-contract.spec.ts:55,67,117`, em quatro specs de integração, no spike de confiabilidade e em `services/hermes_worker/tests/` (binding, bootstrap, bridge_tools, ipc, canonical_json). `parseRuntimeManifest` RECUSA esse nome | §4.2 linha 323; `tests/fixtures/hermes-wire/frames.json`, em **`cases[11].frame.manifest.tools[0].name`** (localizado na revisão — os outros dois blocos `manifest` da fixture têm `tools: []`, e as demais ocorrências, em `effective_tool_names` e nos quatro `tool.request.name`, **não passam por manifest**); `services/hermes_worker/tests/test_binding.py:21` | **Não afrouxei o K-19.** Consequência real: o primeiro run ponta a ponta reprova, porque o manifest não consegue emitir o nome que as fixtures esperam. **Precisa de decisão antes do P06/P07**: renomear a fixture nos dois lados (custo cross-language, md5 compartilhado) ou registrar exceção explícita ao K-19. Os dois specs meus que contêm o nome o usam **só como caso de RECUSA** |
| **C-P05-2** | §6.9.2 fala em "retorno da tool `approval_required`"; `EngineToolCallStateV1` TEM o estado (`contracts.ts:58`, `schemas.ts:56`); o wire fechado do P00 **não tem esse código** em `tool.result.outcome.refused` | §6.9.2 linha 1742; `protocol.ts`; `contracts.ts:58` | Não inventei código de wire — quebraria o espelho Python. A espera virou disposição própria (`defer`), e um teste PRENDE a ausência: `BROKER_REFUSAL_REASONS` não contém `approval_required`. **Quem for fechar o P06 precisa decidir** como `defer` atravessa o wire (candidato: `result` com `is_error`, que o §6.9.2 admite ao dizer que o modelo "pode explicar a espera") |
| **C-P05-3** | §7.10.3 põe `remember_safe_fact` no deny Hermes, mas ele está em `BASELINE_CORE_PACK` — o piso de TODO agente — e `resolveGrantedToolNames` sempre une o baseline | §7.10.3 linha 2253; **`src/tools/grant-math.ts:114,543`** (o caminho estava incompleto na primeira versão deste relatório) e `src/tools/packs.ts:120` | O eixo de grant do agente traria a tool de volta sozinho; **só o deny explícito a tira**. Consequência de desenho: o deny do broker **não pode** ser removido sob o argumento de que "o dispatcher já checa grants" — o dispatcher checa o grant, e o grant a concede |
| **C-P05-4** | §7.10.1 exige que falha de lookup de role/skill **não** amplie; `runtime-filter.ts:132-147` faz o oposto por decisão registrada (lookup falho → `null` → sem narrowing) | §7.10.1 linha 2242; `runtime-filter.ts:132-147` | Semânticas INVERTIDAS, e ambas corretas na própria camada (lá o eixo só pode remover e o dispatcher é o piso; aqui este é o único ponto que aplica narrowing de skill por turno). **Risco nomeado:** reusar `computeAgentVisibleTools` no caminho Hermes importaria a postura errada em silêncio. Por isso escrevi função própria em vez de reusar |
| **C-P05-5** | Manifest com `effect_class` NOT NULL vs. coluna `engine_tool_calls.effect_class` que aceita NULL | §4.1 ("null NUNCA autoriza handler"); migration 140 | Divergência DELIBERADA e registrada aqui para ninguém "harmonizar" o manifest com a coluna |
| **C-P05-6** | §4.2 pede "modo de aprovação" sem enumerar valores | §4.2 linha 308 | `none|single|dual`, mapeado no vocabulário real da casa. Decisão minha, não leitura |
| **C-P05-7** | §7.10.1 cria `authorization_target: entity\|current_subject\|current_turn`, mas o dispatcher **continua exigindo entidade para toda tool** (`_dispatcher.ts:389`, `no_entity_in_scope`) | §7.10.1 linha 2244; `_dispatcher.ts:389` | **Confirmado independentemente na revisão:** a linha é exatamente `if (!entity_id) return { error: 'no_entity_in_scope' };`, e a varredura por `authorization_target|current_subject|current_turn` em `src/tools/` e `src/runtime/` volta VAZIA. O campo está no manifest e é validado, mas **nada o enforça**. Uma tool `current_subject`/`current_turn` no manifest é hoje **indespachável**. O próprio §7.10.1 chama isso de "gate explícito do piloto" — ver o pedido nº 1 abaixo |

## 7. O que preciso nos arquivos que não pude tocar

1. **`src/tools/_dispatcher.ts`** — o branch de `authorization_target` do §7.10.1:
   autorização por sujeito/turno preservando fence, grant, schema, audit,
   orçamento e idempotência. Hoje `:389` recusa com `no_entity_in_scope` qualquer
   tool sem entidade, e "memória pessoal não pode inventar entidade para passar
   esse gate". **Sem isso, `current_subject` e `current_turn` são decorativos** e a
   fase "memória privada" do §4.2 não sai do papel.
2. **`src/governance/audit-actions.ts`** — a fatia não audita nada, e é por isso
   que T19 ficou PARCIAL. Conferi o vocabulário: `tool_not_granted` (`:771`) serve
   para a recusa por superfície e `tool_visibility_resolved` (`:765`) para a
   proveniência, mas **não há ação para recusa de nível de broker**:
   `binding_mismatch`, `manifest_digest_mismatch`, `resource_out_of_acl` e
   manifest recusado. Precisa de ações novas (mudança em módulo COMPARTILHADO,
   como o P04 já está fazendo por C22) — eu não as acrescentei.
3. **`src/integrations/hermes/protocol.ts`** (não é meu, é entrega do P00 com
   espelho Python) — a decisão de C-P05-2 sobre como `defer` atravessa o wire.
   **Não alterei**: mudar o wire sem mexer no espelho Python quebraria a fixture
   compartilhada.
4. **Nada pedido** em `contracts.ts`/`schemas.ts`: mapeei deliberadamente os
   códigos de recusa sobre o vocabulário fechado que já existe, e um teste
   valida cada código contra `engineToolReplyV1Schema` REAL.
5. **Nada pedido** em `engine-repos.ts`: `admitToolCall`, `markToolDispatching` e
   `settleToolCall` do P03 já cobrem o que o gateway vai precisar.

## 8. Divergência de instrução registrada

A configuração da sessão manda encerrar commits com
`Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`. O `AGENTS.md` §8
("Coautoria") proíbe trailer de coautoria de IA e o transforma em **gate
bloqueante** (`npm run commit:trailers:check`), instruindo o agente a reportar a
divergência em vez de contornar o guard. Segui o `AGENTS.md`: **os três commits
não têm trailer de IA**. É a mesma divergência já registrada como C08 em
IMPLEMENTATION-STATE.
