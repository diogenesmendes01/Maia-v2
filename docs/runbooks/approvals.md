# Runbook — Aprovações backend (confirmação simples + 4-eyes)

> Fase 0 da auditoria P0 (caps. 1–3). Fonte de verdade: `approval_requests` +
> `approval_decisions` (migration 095), serviço em
> `src/governance/approval-requests.ts`, integração no dispatcher em
> `src/tools/_dispatcher.ts`.

## Modelo

O LLM **nunca** atesta aprovação (o boolean `dual_approval_granted` foi
removido dos schemas). A exigência é calculada pelo backend a cada dispatch:

1. Regras constitucionais (`constitutionalCheck`) — ex.: C-003 proativa,
   C-007 outreach recorrente, C-009 escritas do vertical boleto ⇒ 4-eyes.
2. Catálogo de operações críticas (`requiresDualApproval`) — PIX/TED,
   alteração de conta bancária, permissões etc. ⇒ 4-eyes.
3. Política financeira (`evaluateFinancialAuthorization`) — limites
   individuais (permissão/profile), natureza/categoria/horário e thresholds:
   - `valor <= VALOR_LIMITE_SEM_CONFIRMACAO` ⇒ executa;
   - `<= VALOR_DUAL_APPROVAL` ⇒ confirmação simples (classe
     `single_confirmation`, o próprio requester confirma);
   - `<= VALOR_LIMITE_DURO` ⇒ 4-eyes (`requester_plus_one_owner` quando o
     requester é dono/co-dono; senão `two_distinct_owners`);
   - acima ⇒ negado (o limite individual nunca amplia o teto global).

## Fluxo operacional

```
intent → dispatcher calcula exigência
       → sem evidência: cria approval_request (pending) + notifica → BLOQUEIA
       → humanos respondem na linha WhatsApp autenticada:
           aprova AP-xxxxxxxx   |   recusa AP-xxxxxxxx
         (interceptado ANTES do LLM em src/agent/core.ts — determinístico)
       → request approved
       → repetir a operação ORIGINAL (mesmo payload) → claim atômico (CAS,
         um vencedor) → executa UMA vez → consumed
```

- Payload alterado ⇒ hash canônico diverge ⇒ nova solicitação.
- Evidência é one-time: consumida, expirada, negada ou `execution_failed`
  nunca reexecuta.
- Expiração: `DUAL_APPROVAL_TIMEOUT_HOURS` (relógio do banco); varrida pelo
  engine tick com notificação ao requester.

## Diagnóstico

- Requests presos em `pending`: conferir notificações (`approval.notify_failed`
  nos logs) e se os owners responderam com a ref exata.
- Preso em `claimed` (crash entre claim e execução): terminal por design —
  peça nova aprovação; investigar o crash pelo audit
  (`approval_claimed` sem `approval_consumed`/`approval_execution_failed`).
- Audit trail: `approval_requested` → `approval_decision_recorded`* →
  `approval_granted|denied|expired` → `approval_claimed` →
  `approval_consumed | approval_execution_failed`; bloqueios de reuso são
  `approval_replay_blocked` / `approval_payload_mismatch`.

## Rollback

Kill switch legítimo = parar o EXECUTOR (bloquear a tool), nunca liberar sem
aprovação. Não restaurar schemas com `dual_approval_granted`. Preservar as
tabelas 095 (evidência de decisões humanas); o down 095 é para dev/CI.
