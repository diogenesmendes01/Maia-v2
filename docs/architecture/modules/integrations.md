# `src/integrations/` — pontes para motores externos

> Módulo NOVO (spec `docs/superpowers/plans/2026-09-15-maia-hermes-engine/`). Hoje
> tem um único integrante: a ponte para o motor de raciocínio Hermes.

## Papel

Falar com um processo que **não é a Maia** e traduzir essa conversa para os
contratos da Maia — sem nunca deixar o outro lado escolher identidade,
autorização ou entrega.

A regra que organiza o diretório inteiro: **o que atravessa a fronteira é
proposta; o que decide fica aqui dentro (ou mais acima).** Um motor externo
propõe texto e pedidos de ferramenta. Quem resolve tenant, pessoa, conversa,
grants, aprovação, idempotência e envio continua sendo a Maia
(`ARCHITECTURE.md` §3, invariantes 1, 2 e 5).

## Conteúdo

| Arquivo | Papel |
|---|---|
| `hermes/protocol.ts` | Contrato wire `maia.hermes.worker.v1` (NDJSON): schemas Zod estritos nos dois sentidos, limites de bytes/profundidade, recusa de chaves desconhecidas e derivação de `call_id` |
| `hermes/canonical-json.ts` | Serialização canônica versionada + digest sha256 usados como identidade de pedido/resultado |

Planejados nas fatias seguintes (ainda **não** existem): `supervisor.ts`
(ciclo de vida do processo filho), `run-binding.ts`, `tool-broker.ts`,
`manifest.ts`, `inference-gateway.ts`. O pacote Python do worker vive fora de
`src/`, em `services/hermes_worker/`, porque não é código do runtime Node.

## Invariantes deste módulo

1. **Nenhum campo do frame estabelece autoridade.** O canal é autenticado pela
   posse do pipe criado pelo supervisor; `run_id` no frame é correlação,
   comparada e recusada em divergência. Schemas fechados (`.strict()`) nos dois
   sentidos: chave desconhecida recusa o frame em vez de ser ignorada.
2. **Identidade de chamada é do transporte.** O frame traz `call_seq` (começa em
   zero); `call_id = run_id:call_seq` é derivado aqui. O modelo não escolhe id de
   chamada nem de execução.
3. **Limites recusam, não truncam.** Frame, payload de ferramenta e profundidade
   de JSON têm teto; exceder é erro tipado. Truncar transformaria um payload
   recusável num payload plausível.
4. **Segredo não trafega em frame.** A credencial curta de inferência chega ao
   filho por variável de ambiente allowlisted no spawn; o schema recusa
   `api_key`/`token`/`authorization` dentro de `inference`.
5. **Nada aqui envia mensagem.** A saída continua sendo do coordenador de
   outbound da Maia; um resultado do motor é candidato, nunca entrega.

## Fronteiras

- **Não** importa SDK de provider (regra de lint `no-restricted-imports`) — a
  inferência do filho passa pelo gateway interno da Maia.
- **Não** lê `process.env` (regra de lint); configuração vem do contrato
  (`src/config/contract.ts`).
- **Não** conhece Baileys, repositórios de negócio nem o dispatcher: quem os usa
  é o broker, nas fatias seguintes, sempre por `dispatchTool`.

## Testes

- `tests/unit/hermes-wire-contract.spec.ts` — contrato wire (T05, T07, T08, T20 parcial, T70 da matriz da spec).
- `tests/fixtures/hermes-wire/frames.json` — casos compartilhados com o pacote Python (`services/hermes_worker/tests/`): as duas implementações precisam aceitar/recusar exatamente os mesmos frames.
