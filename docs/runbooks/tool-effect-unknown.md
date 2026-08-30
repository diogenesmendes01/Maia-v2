# Runbook — `effect_unknown`: uma ferramenta pode ter agido, e não sabemos

**Issue:** #507 · **Código:** `effect_unknown` · **Auditoria:** `tool_effect_unknown`

## O que aconteceu

Uma tentativa de turno foi cancelada — perda de lease por takeover, shutdown,
prazo, cancelamento administrativo — **depois** de o handler de uma ferramenta
poder ter produzido efeito, e a ferramenta **não** é `abort_safe`.

O dispatcher não afirma "cancelado" (isso diria que nada aconteceu) nem trata o
caso como falha comum (isso convidaria a um retry que duplicaria o efeito). Ele
declara que **não sabe** e abre uma dívida de reconciliação.

Isto **não é** um bug da plataforma. É a plataforma dizendo a verdade sobre um
limite real: `AbortSignal` é cooperativo, e um efeito externo já iniciado não
volta atrás porque um processo mudou de ideia.

## O que o sistema já fez sozinho

| Ação | Onde | Por quê |
|---|---|---|
| Descartou o resultado do handler | `src/tools/_dispatcher.ts` | um turno que não é mais nosso não incorpora resposta nem dispara outbound |
| Marcou a reserva de idempotência como `failed` | `idempotency_keys` | a MESMA chave passa a falhar rápido (`idempotency_prior_failed`) em vez de reexecutar sozinha |
| Tornou terminal a evidência de aprovação, se havia | `approval_requests` | um efeito que talvez tenha acontecido já consumiu o "sim" do humano; repetir exige aprovação NOVA |
| Gravou a linha de reconciliação | `audit_log`, ação `tool_effect_unknown` | é a unidade de trabalho deste runbook |
| Contou a série | `maia_tool_effect_unknown_total{tool,effect_class,reconciliation}` | um pico é dívida acumulando, não outage |

## Onde olhar

```sql
SELECT created_at,
       metadata->>'tool'            AS tool,
       metadata->>'effect_class'    AS classe,
       metadata->>'reconciliation'  AS estrategia,
       metadata->>'cause'           AS causa,
       metadata->>'idempotency_key' AS chave,
       metadata->>'turn_id'         AS turno,
       metadata->>'attempt'         AS tentativa
  FROM audit_log
 WHERE tenant_id = $1 AND agent_id = $2
   AND acao = 'tool_effect_unknown'
   AND created_at > now() - interval '24 hours'
 ORDER BY created_at DESC;
```

`cause` distingue três janelas:

| `cause` | O que significa |
|---|---|
| `signal_aborted` | o handler REJEITOU cooperando com o abort — a dependência subjacente provavelmente parou, mas não há garantia sobre o que já tinha saído |
| `late_result_discarded` | o handler CONCLUIU e o resultado chegou depois do cancelamento — o efeito muito provavelmente existe |
| `completion_fenced` | o handler concluiu e outro dono tomou a reserva no meio — o efeito existe, o resultado não virou o cache autoritativo |

## O que fazer, por estratégia

A estratégia vem da classe declarada da ferramenta
(`src/tools/effect-class.ts`) e está na própria linha de auditoria.

### `replay_idempotency_key` (classe `idempotent`)

O efeito da ferramenta converge: repetir com a mesma entrada leva ao mesmo
estado. Ainda assim **não há retry automático** — a reserva ficou `failed` de
propósito.

1. Confirme no sistema de destino se o efeito existe.
2. Se existir e estiver correto, feche a dívida: nada a fazer.
3. Se não existir, reexecute deliberadamente. A reserva terminal precisa ser
   liberada primeiro (ela expira sozinha ao fim do TTL da chave).

### `compensate` (classe `compensatable`)

A linha de auditoria traz `compensated_by`, o nome da ferramenta que desfaz.

1. Verifique se o efeito existe (`turn_id` + `idempotency_key` são as âncoras).
2. Se existir e for indevido, execute a compensação nomeada.
3. Se existir e for devido, feche a dívida.

### `manual_reconciliation` (classe `non_interruptible`)

Não há repetição segura nem compensação declarada — normalmente um envio
externo, um ticket, uma criação sem chave natural.

1. Olhe o sistema de destino diretamente.
2. Decida caso a caso. Se o padrão se repetir para a mesma ferramenta, o
   caminho estrutural é dar a ela uma compensação explícita (e reclassificá-la
   como `compensatable`) ou torná-la idempotente.

## Quando isto vira incidente

Um ponto isolado é o desenho funcionando. O que merece investigação:

| Sinal | Provável causa |
|---|---|
| Crescimento sustentado de `maia_tool_effect_unknown_total` | takeovers demais — lease curta, heartbeat sufocado, ou GC/provedor lento |
| Concentração numa ferramenta só | handler longo demais; considere reduzir o trabalho por chamada |
| `maia_tool_deadline_exceeded_total` subindo junto | orçamento do turno mal dimensionado, ou etapa anterior consumindo o prazo |

Correlacione com `maia_turn_lease_lost_total{reason}` — `token_mismatch` aponta
takeover, `heartbeat_failed` aponta banco indisponível.

## O que NÃO fazer

- **Não reexecute em massa.** A dívida é sobre não saber; um replay cego
  converte incerteza em duplicata garantida para tudo que não é `idempotent`.
- **Não reclassifique uma ferramenta como `abort_safe` para calar a série.** A
  classe é a declaração de que cancelar não deixa efeito; o registro recusa
  `abort_safe` em quem declara `side_effect: 'write'`, e por uma razão.
- **Não trate `effect_unknown` como sinônimo de falha.** O handler pode ter
  funcionado perfeitamente; o que falhou foi a nossa capacidade de saber.
