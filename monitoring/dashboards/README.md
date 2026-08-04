# Dashboards versionados (issue #535)

Três dashboards Grafana, um por pergunta operacional. JSON no repo — não
clicado numa UI — para que a mudança de um painel passe por review como
qualquer outra e para que um Grafana recriado do zero volte idêntico.

| Arquivo | Pergunta que responde |
|---|---|
| [`maia-turn-slo.json`](maia-turn-slo.json) | *A plataforma está correta?* Disponibilidade, latência E2E, orçamento de erro, cobertura de envelope, violações do portão de labels. |
| [`maia-capacity.json`](maia-capacity.json) | *A plataforma dá conta?* Backlog de fila, estados de turno, pool do Postgres, atraso do scheduler, sessão WhatsApp. |
| [`maia-llm-tools-otlp.json`](maia-llm-tools-otlp.json) | *A camada de ação está saudável?* Erro/latência/tokens de LLM, dispatch de tool por desfecho, saúde do exporter OTLP. |

## Como importar

```bash
# via UI: Dashboards → New → Import → Upload JSON
# via provisioning (preferido — versionado):
#   monte monitoring/dashboards/ read-only no container do Grafana e aponte
#   um provider de arquivo para o diretório:
```

```yaml
# /etc/grafana/provisioning/dashboards/maia.yml
apiVersion: 1
providers:
  - name: maia
    folder: Maia
    type: file
    disableDeletion: true
    allowUiUpdates: false
    options:
      path: /etc/grafana/dashboards/maia
```

`allowUiUpdates: false` é deliberado: editar na UI produziria um painel que o
repo não conhece e que o próximo deploy sobrescreve silenciosamente. Edite o
JSON.

Os painéis assumem o datasource Prometheus que carrega
[`../alerts/slo.rules.yml`](../alerts/slo.rules.yml).

## Duas regras que os painéis seguem

**1. Painel lê recording rule, não expressão solta.** Quase toda consulta aqui
referencia uma regra `maia:*` de `slo.rules.yml`. É o que garante que o número
do painel e o número que disparou o alerta são o MESMO número — dashboard e
alerta divergindo é como um incidente vira uma discussão sobre qual gráfico
está certo. Quando não há regra (quebra por `reason`, `topk` de exploração), a
expressão está inline e o painel diz por quê.

**2. Nenhum painel expõe identificador de alta cardinalidade.** `tenant_id` e
`agent_id` são a exceção sancionada (AGENTS.md §4.1) e aparecem só sob `topk`.
`trace_id`, `conversa_id`, telefone e JID **não são labels de métrica** por
construção (`src/observability/labels.ts`) e portanto não são plotáveis — a
correlação de um caso individual vive no Trace Explorer do Admin e no log, não
aqui.

## Regra de agregação (a que mais dá errado)

| Métrica | Agregue com | Por quê |
|---|---|---|
| `maia_queue_depth`, `maia_queue_oldest_job_age_ms` | `max` | toda réplica reporta a MESMA fila Redis; `sum` multiplicaria o backlog pelo número de réplicas |
| `maia_scheduler_lag_ms`, `maia_scheduler_backlog` | `max` | mesma razão — Postgres compartilhado |
| `maia_db_pool` | por `instance` | cada processo tem o SEU pool; colapsar réplicas esconde a saturada na média |
| `maia_whatsapp_sessions` | por `instance` | idem — um socket por processo |
| `maia_*_total` | `sum` de `rate()` | contadores; `rate()` já é restart-safe |

## Guia de drift

`tests/unit/observability/dashboards.spec.ts` falha se um painel referenciar
métrica que ninguém emite ou recording rule que não existe. Um painel que
aponta para série inexistente parece cobertura e mostra "sem dados" para
sempre — o mesmo defeito que a issue #535 abre denunciando na taxonomia de
spans.
