# ADR: o boot decide pelo veredito canônico de schema e encerra o processo

| Field | Value |
|---|---|
| Status | Accepted |
| Date | 2026-08-24 |
| Owner | Maia maintainers |
| Related issue | [#516](https://github.com/diogenesmendes01/Maia-v2/issues/516) |
| Related PR | — |

## Context

A #516 entregou o **veredito canônico de schema** (`getSchemaReadiness()`,
`src/migrations/readiness.ts`): a resposta fail-closed, read-only e que nunca
lança para "esta build pode servir tráfego contra este banco?". Ele nomeia seis
condições que um schema incompatível pode ter — linha `dirty`, `running`
órfã, checksum divergente, checksum ausente, migration aplicada que a build não
empacota, e head fora da faixa suportada.

O `/readyz` passou a consumi-lo (ADR 0003 mantém `/readyz` como o **único** gate
de roteamento, role-aware e fail-closed). O **boot**, porém, ficou com o check
anterior, `checkSchemaVersion()`, que comparava o id mais novo do ledger com o
`.sql` mais novo em disco e **nada mais**: não via checksum divergente, não via
`dirty`, não via arquivo ausente, e reportava "banco à frente do artefato" como
`ok`.

Ou seja: havia **dois vereditos de schema** no processo, com forças diferentes,
e o mais fraco era o que decidia se o processo nascia. Um app podia subir
tranquilo sobre uma migration editada depois de aplicada e só descobrir na
primeira query que tocasse a coluna nova.

`docs/architecture/modules/migrations.md` registrava a unificação como **decisão
de política em aberto, do dono** — não uma limpeza que um agente pudesse fazer
sozinho, porque troca a postura operacional inteira.

## Decision

**O boot consulta `getSchemaReadiness()` e DECIDE. Qualquer veredito que não
seja `ready` encerra o processo com exit code != 0 e específico da invariante
quebrada.** `checkSchemaVersion()` foi removido: não existe mais um segundo,
mais permissivo, veredito de schema em lugar nenhum do código.

Decisão do dono, registrada na #516:

> Produção greenfield não precisa preservar a postura intermediária.
> `getSchemaReadiness()` deve decidir o boot; dirty state, checksum divergente,
> migration ausente ou schema incompatível devem encerrar o processo com código
> de saída diferente de zero. O migration gate deve impedir que isso aconteça no
> caminho normal. Se acontecer, o crash loop é sinal de quebra de invariante.

Três compromissos vêm junto, e nenhum é opcional:

1. **Exit codes distinguíveis.** `1` continua sendo "outra falha de boot". O
   gate de schema usa a faixa **90-98**, uma por invariante — tabela em
   `src/runtime/lifecycle/schema-boot-gate.ts` e em
   [`docs/runbooks/operational.md`](../../runbooks/operational.md) §8.1. A faixa
   foi escolhida para não colidir com o que já significa outra coisa: 0/1/2 do
   migrator, 1-14 do Node, 126-165 do shell, 255.
2. **Mensagem de morte acionável.** `maia.schema_boot_refused` carrega
   `exit_code`, `blocker`, `migration_id`, `expected_checksum` (arquivo
   empacotado), `found_checksum` (linha do ledger), os dois heads e a
   `remediation`. Um crash loop sem diagnóstico no log é pior que um 503 — essa
   linha é o que paga a diferença. Nada nela carrega SQL, texto de driver ou
   DSN (uma mensagem do `pg` embute a connection string com senha).
3. **O gate de migration é o que impede o crash loop no caminho normal.** O job
   one-shot do Compose (`service_completed_successfully`) e, fora do Compose,
   `npm run release:migrate` (#565). Se o app está em crash loop por schema, a
   primeira pergunta é se o gate rodou.

## Options Considered

| Opção | Prós | Contras |
|---|---|---|
| **A — manter o check fraco no boot** (status quo) | O processo fica de pé e **inspecionável**: dá para entrar nele, rodar `migrate status`, ler o log. Uma condição de schema custa uma instância fora de rotação, não um loop. | Dois vereditos de schema no mesmo processo, com forças diferentes — o mais fraco decidindo o nascimento. Uma instância nunca-pronta pode ficar assim indefinidamente se ninguém tiver alerta em `/readyz`. E o app sobe sobre schema editado/parcial e falha na primeira query que tocar o novo, longe do boot. |
| **B — o boot decide pelo veredito canônico e morre (escolhida)** | Um veredito só, em toda a plataforma. O sinal é impossível de ignorar. Nenhuma instância meio-viva entra em rotação. O exit code carrega o diagnóstico para fora do processo, onde o supervisor já olha. | Sob supervisor que reinicia, vira **crash loop**, e o container que você precisa inspecionar é justamente o que não fica de pé. Depende de a mensagem de morte ser boa (por isso ela é parte do contrato) e do gate de migration ser real (por isso ele é citado aqui). |
| **C — variável nova para diferenciar produção de dev** | Dev/CI ficariam imunes por construção. | Uma variável a mais no contrato, e uma postura que difere por ambiente é uma postura que ninguém testa no ambiente que importa. Já existe a alavanca declarada — `READINESS_SCHEMA_CHECK` — e ela já é recusada em `production`. Recusada. |

## Consequences

Positivo:

- O veredito de schema é **um só** — `/readyz`, `maia doctor`, `/metrics`,
  `migrate status` e agora o boot leem a mesma função.
- `docker inspect --format '{{.State.ExitCode}}'` responde "qual invariante
  quebrou" antes de qualquer log.
- A postura é falsificável no call site REAL:
  `tests/unit/runtime/schema-boot-gate.spec.ts` importa `src/index.ts` (a
  avaliação do módulo dispara `main()` e o handler de falha) e reprova se o
  bloco de decisão sair de lá, ou se o `process.exit(bootExitCode(err))` virar
  um `process.exit(1)`.

Negativo:

- **Crash loop é agora um modo de falha real da plataforma.** O rastro fica no
  log do container morto, não num endpoint. Quem opera precisa saber ler exit
  code — daí a árvore de decisão em `operational.md` §8.1.
- **`npm run dev` contra um banco de outra branch morre.** Não há exceção por
  ambiente: a alavanca é `READINESS_SCHEMA_CHECK=false`, silenciosa em
  `development`, aviso em `staging`, recusada no boot em `production`. O CI não
  é afetado — nenhuma suíte executa o `main()` de `src/index.ts` a não ser a
  spec do gate, que injeta o próprio ledger.
- Um `/readyz` que nunca responde deixou de significar "instância doente": pode
  significar "processo que nunca nasceu". Os dois sinais são complementares e a
  ordem de leitura está documentada.

## Relação com a ADR 0003

Nenhuma tensão, e vale dizer por quê. A ADR 0003 decide **quem carrega
veredito no status HTTP**: `/livez`, `/startupz` e `/readyz` sim; `/health` não.
Esta ADR decide **o que acontece antes de existir HTTP**. O `/readyz` continua
sendo o único gate de roteamento, role-aware e fail-closed, e continua
respondendo 503 com o componente `schema` nomeado quando o schema muda debaixo
de um processo que já subiu — esse caso não vira crash loop, porque o processo
já existe e o veredito só muda a rotação.

| Situação | Sinal que o operador lê |
|---|---|
| processo não sobe (crash loop) | **exit code** (90-98 = schema) + `maia.schema_boot_refused` |
| processo no ar, schema mudou debaixo dele | **`/readyz` 503** com `checks[].component == "schema"` |
| "qual componente está ruim?" | `/health` — diagnóstico, 200 sempre (ADR 0003) |

## Validation

- `tests/unit/runtime/schema-boot-gate.spec.ts` — os quatro vereditos negativos
  (mais `checksum_unknown` e `unknown`) dirigidos pelo **`src/index.ts` real**,
  com pool e diretório de migrations injetados; asserta exit code por
  invariante, campos da mensagem de morte e o contraste do caminho feliz (o
  boot passa do schema e morre no passo seguinte com exit 1).
- `tests/integration/migrations-runner-real-db.spec.ts` — a mesma tradução
  veredito ⇒ exit code contra **Postgres real** (ledger real, linha `dirty`
  real, ledger derrubado).
- `tests/integration/lifecycle-probes.spec.ts` — num banco migrado de verdade o
  gate de boot não produz recusa nenhuma.

## Reversal Criteria

Revisitar — não apenas reler — se:

- o gate de migration deixar de ser garantido no ambiente de deploy (sem
  `service_completed_successfully` e sem comando de pré-deploy): sem ele, o
  crash loop deixa de ser sinal de invariante quebrada e vira o fluxo normal;
- a plataforma passar a rodar réplicas com schema deliberadamente heterogêneo
  durante um rollout expand/contract longo, a ponto de "morrer" ser mais caro
  que "não entrar em rotação";
- surgir um supervisor sem retenção de log de container morto, onde a mensagem
  de morte não sobrevive ao restart.

## References

- Issue [#516](https://github.com/diogenesmendes01/Maia-v2/issues/516) — checksum, dirty state e schema readiness.
- Issue #565 — o gate de migration fora do Compose (`npm run release:migrate`).
- [ADR 0003](0003-health-is-diagnostic-livez-readyz-are-the-probes.md) — `/health` é diagnóstico; `/livez` e `/readyz` carregam veredito.
- `src/runtime/lifecycle/schema-boot-gate.ts` — tabela de exit codes, precedência e mensagem.
- `src/index.ts` — o call site: etapa `schema` e o handler de falha de `main()`.
- [`docs/runbooks/operational.md`](../../runbooks/operational.md) §8.1 — árvore de decisão do operador.
- [`docs/runbooks/migrations.md`](../../runbooks/migrations.md) — recovery, repair e o job one-shot.
