# `services/hermes_worker` — worker privado `maia.hermes.worker.v1`

Pacote Python que hospeda **um** `AIAgent` do Hermes pinado e conversa com a
Maia por um pipe privado em NDJSON. Implementa a unidade **P00.2** da spec
`SPEC-IMPLEMENTACAO-MAIA-HERMES.md` (§6.4 a §6.8).

O worker não tem autoridade. Ele registra as ferramentas que a Maia mandou
registrar, pede execução pelo pipe e projeta o resultado. Quem decide tenant,
pessoa, aprovação e efeito é o broker da Maia, do outro lado do canal.

| Arquivo | Papel |
|---|---|
| `canonical_json.py` | Espelho de `src/integrations/hermes/canonical-json.ts` — forma canônica e digest |
| `protocol.py` | Os 9 frames, leitor NDJSON com limites, escritor com lock |
| `binding.py` | `WorkerBinding` imutável (§6.4.1) |
| `bridge_tools.py` | Closures de handler e registro no `ToolRegistry` (§6.5) |
| `ipc.py` | Cliente IPC (`call_seq`, futures) e bomba de controle |
| `result_projection.py` | Precedência de desfecho do §6.8, função pura |
| `main.py` | Bootstrap na ordem do §6.7.2 |

## Rodando os testes

A suíte **não importa o Hermes** e **não faz rede**. Basta um Python 3.12 com
pytest:

```bash
python -m venv .venv && .venv/Scripts/python -m pip install pytest
cd services/hermes_worker
.venv/Scripts/python -m pytest
```

Rode com ambiente limpo (sem `HERMES_HOME`, sem `ANTHROPIC_*`, sem chave de
API). O `conftest.py` já remove essas variáveis do processo de teste, mas o
hábito vale: um teste que por acidente construísse um agente usaria o que
estivesse exportado.

> O venv do checkout Hermes pinado **não tem `pip`** (`No module named pip`), por
> isso a suíte foi desenvolvida e executada num venv próprio criado com o Python
> 3.12 do sistema. Nada no pacote depende das dependências do motor.

## Decisões que valem explicação

**Separação de IPC e log por duplicação do FD 1.** Antes de qualquer import do
Hermes, `split_ipc_from_logs()` duplica o FD 1 (o pipe que o supervisor
entregou) para o escritor do protocolo e faz `dup2(2, 1)`, de modo que tudo que
imprimir em stdout caia no stderr. O motivo é verificado: mesmo com
`quiet_mode=True` o Hermes imprime em stdout — `agent/turn_tool_validation.py:96`
faz `print` incondicional ao reparar nome de ferramenta. Preferimos duplicar o
FD 1 a herdar um terceiro descritor porque a herança de FD extra não é garantida
pelo `child_process` do Node no Windows; a estratégia escolhida funciona igual
em POSIX e Windows, não abre porta nenhuma e não depende de pipe nomeado. O
canal de entrada é o FD 0.

**Home efêmero obrigatório.** `require_ephemeral_home()` exige `HERMES_HOME`
absoluto, novo e vazio, e recusa o perfil pessoal do Hermes Desktop
(`%LOCALAPPDATA%\hermes` no Windows, `~/.hermes` fora dele) e qualquer caminho
dentro dele. Sem isso, `get_hermes_home` cai no default da plataforma
(`hermes_constants.py:101-108`) e **o simples import** já cria `state.db`,
`SOUL.md`, `memories/` e `sessions/` no perfil de quem rodou.

**Dois valores do `config.yaml` não são cosméticos** (`render_worker_config`):

- `model.context_length` — sem ele, construir o `AIAgent` faz **I/O de rede**.
  `_enforce_minimum_context` (`agent/agent_init.py:1890`) lê o
  `context_compressor.context_length`, que resolve por `get_model_context_length`
  (`agent/model_metadata.py:1945`); o passo 0 só retorna sem tocar a rede quando
  há inteiro positivo configurado (`:1946-1948`). O piso é 64.000
  (`MINIMUM_CONTEXT_LENGTH`, `model_metadata.py:318`) — abaixo disso o construtor
  levanta `ValueError`, e por isso a função recusa valores menores.
- `tools.tool_search.enabled: "off"` — o default é `"auto"`
  (`tools/tool_search.py:64`) e `should_activate` trata `auto` como `on` sempre
  que existir **qualquer** tool diferível (`:189-198`). Com o default, a
  superfície efetiva vira `tool_search`/`tool_describe`/`tool_call` e **nenhuma**
  tool da Maia aparece ao modelo. As aspas também importam: `off` sem aspas é
  booleano em YAML 1.1.

**Registro conferido duas vezes.** `registry.register` devolve `None` em
silêncio quando rejeita (`tools/registry.py:676-682`). `register_bridge_tools`
checa `get_entry` **antes** (colisão) e **depois** (registro aceito) — sem a
segunda checagem o bootstrap seguiria para o `ready` com uma tool a menos.

**Nenhuma exceção sai do handler, e nenhuma mensagem carrega payload.**
`registry.dispatch` ecoa o texto da exceção ao modelo
(`tools/registry.py:857-866`, confirmado por probe). Todas as recusas são
códigos fechados em JSON. `tests/test_bridge_tools.py` percorre todos os
caminhos de saída com um segredo no payload e afirma que ele não aparece.

**`call_seq` é gerado uma vez por chamada.** Um `in_progress` da Maia faz o
cliente reenviar o **mesmo** `call_seq` (`ipc.py`), porque isso é reentrega de
transporte. Gerar outro número transformaria a reentrega numa segunda operação
de negócio para o broker, que deduplica por `(execution_id, call_seq)`.

**Tradução de desfechos (§6.8).** A precedência é estado autoritativo →
`interrupted` → `failed` → `partial`/`completed is not True` → candidato. Ela
não é opcional: o `completed` do finalizador é
`final_response is not None and not failed and api_call_count < max_iterations`
e **não testa `interrupted`**, então um turno cancelado volta com
`completed=True` e texto. Três traduções são decisão deste pacote:

| Situação | Desfecho emitido | Por quê |
|---|---|---|
| `cancel` com `reason=deadline` | `failed/deadline_exceeded` | o conjunto fechado de `cancelled` não tem `deadline`; o de `failed` tem o código exato |
| `cancel` com `reason=policy` | `cancelled/operator` | `cancelled` só admite `ownership_lost`/`operator`/`shutdown` |
| `interrupted=True` sem `cancel` | `cancelled/shutdown` | o contrato não tem "o motor se interrompeu sozinho"; inventar um `reply` seria pior |

**Controle que chega antes do loop (§6.7.2 item 3, §6.7.3 item 2).** O que vem
colado ao `start` no mesmo `read` do pipe é entregue à bomba, na ordem, antes de
ela começar a ler (`read_start_frame` devolve `(primeiro, excedentes)`). Duas
barreiras rodam antes do loop: antes de importar o Hermes e antes do `ready`.
Não há janela depois da segunda — quem recebe o controle grava o estado antes de
olhar o agente, então ou a barreira o vê ou o agente é interrompido. Também são
decisão deste pacote:

| Situação | O que o worker faz | Por quê |
|---|---|---|
| `cancel` antes do loop | `cancel_ack` e `result` com o desfecho do cancelamento, `iterations: 0`, nenhum `ready`, sai com 0 | o executor resolveu sem loop, e o `result` é o que diz isso ao supervisor; `ready` afirmaria readiness que não houve |
| segundo `start` antes do loop | nenhum frame além de `cancel_ack` já emitido, sai com `EXIT_PROTOCOL` (4) | canal que violou o protocolo não fecha turno; o erro prevalece sobre um `cancel` recebido junto |
| segundo `start` durante o loop | interrompe o agente, `result` com `failed/protocol_error`, sai com 4 | nenhum texto é candidato depois da violação; as tools já estão fechadas |

Limite: que um `hard_interrupt` feito entre o `ready` e a entrada do loop encerre
o turno é propriedade do motor. O spike (`tests/hermes-spike`) prova o cancel
colado ao `start` e o cancel durante o turno contra o `AIAgent` real, não essa
janela específica.

**`usage.source` nunca é `provider_accounted`.** O worker não fala com o
provider. Com `session_db=None`, o uso auxiliar tem trilha própria e não entra
nos acumuladores da instância (`agent/aux_accounting.py:27-91`), então declarar
contabilidade fechada seria falso. Custo viaja como string inteira de micro-USD.

**Paridade com o TypeScript é testada, não presumida.**
`tests/test_protocol_fixtures.py` lê o mesmo `tests/fixtures/hermes-wire/frames.json`
que a suíte TS e afirma o **código** de cada recusa. `tests/test_canonical_json.py`
fixa bytes e digests **gerados pelo TS** (comando anotado no arquivo). Quatro
divergências Python↔JS foram traduzidas de propósito: formato de número
(`1e-7`, `100`, `100000000000000000`), inteiro acima de 2^53, ordem de chave por
unidade UTF-16 (o emoji vem antes de U+FFFD) e escape de surrogate solitário.

**Separação de arquivos.** `canonical_json.py` é um módulo próprio porque o lado
TS também são dois arquivos — a correspondência fica óbvia. `result_projection.py`
é puro para poder ser testado sem motor, e `ipc.py` separa transporte mutável
(contador, futures, locks) do binding imutável, como o §6.4.1 exige.

## O que NÃO está coberto

Itens honestos, não escondidos:

- **O `AIAgent` nunca foi construído nem executado.** Import, construção e
  `run_conversation` reais são a unidade **P00.4** (provider stub local). Tudo
  aqui que toca o motor — `build_agent_kwargs`, `verify_effective_surface`,
  `register_bridge_tools`, `agent.close()`, `hard_interrupt` — está testado
  contra dublês. `tests/test_bootstrap.py` compara os kwargs com a lista de
  parâmetros reais de `AIAgent.__init__` (`run_agent.py:233-280`, SHA 5d59366)
  fixada no teste, o que pega keyword inventado sem precisar do motor instalado.
- **`_resolved_context_length` devolve 64.000 fixo — UNKNOWN.** O frame `start`
  **não carrega** a janela do modelo roteado. Até o supervisor publicar esse
  campo, usar o piso é o único valor que não inventa capacidade nem dispara
  descoberta por rede. Resolve: acrescentar `inference.context_length` ao
  contrato (exige mudar `protocol.ts` e a fixture — fora do escopo desta unidade).
- **`tool_schema_digest` é definição DESTE pacote.** O `ready` precisa de um
  digest da superfície, e o TS ainda não define como calculá-lo. Adotei
  `canonical_digest` da lista ordenada por nome de
  `{name, input_schema, result_limit_chars}`. **O supervisor precisa calcular
  igual** ao comparar, ou o gate de readiness falha sempre.
- **A projeção do manifest não tem `description`.** O schema do wire só carrega
  `name`/`input_schema`/`result_limit_chars`, então o modelo vê a ferramenta sem
  descrição, a menos que ela venha dentro de `input_schema.description` (que o
  pacote repassa). Decidir isso é de P00.3/P05.
- **`z.string().url()` foi espelhado por regex**, não por um parser WHATWG. Os
  casos da fixture concordam; uma URL exótica pode divergir do `new URL` do
  Node. Resolve: gerar casos-limite e comparar os dois lados.
- **O home efêmero é inventariado, não apagado.** `inventory_home` lista tudo o
  que sobrou (e o `finally` do `run_worker` imprime no stderr). A remoção segundo
  retenção é do supervisor (§6.7.2, item 8): o processo pode morrer antes de
  limpar, e apagar evidência antes de o supervisor lê-la é pior do que deixar.
- **A estratégia de descritores não foi validada contra um spawn real do Node.**
  Ela é a decisão registrada acima; o teste de ponta a ponta é de P00.4.
- **`ready.hermes_sha` vem de `MAIA_HERMES_SHA`.** Se o supervisor não setar, o
  worker emite 40 zeros — que passa no regex mas não identifica build nenhuma.
- **Nada aqui registra tools `maia_*` reais nem toca no dispatcher da Maia**
  (isso é P05), e nenhum teste abre socket, faz rede ou usa provider pago.
