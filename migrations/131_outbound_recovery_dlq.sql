-- =====================================================================
-- Maia — Migration 131 (Issue #633 — fatia D da épica #506)
--
-- O que a recuperação do outbox durável precisa do SCHEMA, e só isso:
--
--   (1) um estado terminal que diga "desistimos", distinto do estado que
--       diz "o provedor recusou" — `dead_letter`;
--   (2) um índice para a varredura de TAKEOVER (lease vencida), que hoje
--       não existe: `idx_outbound_messages_ready` (121, 7c) é PARCIAL em
--       `status IN ('pending','retryable')` e não enxerga `claimed`/
--       `sending`;
--   (3) um índice para a fila de RECONCILIAÇÃO, que também não existe:
--       `delivery_unknown` ficou fora de todo índice da 121 de propósito
--       (ela era a fatia do schema; o consumidor é esta).
--
-- ADITIVA e REVERSÍVEL: nenhuma coluna nasce, muda de tipo, de nulabilidade
-- ou de default; nenhuma row é reescrita; o CHECK de status só GANHA um
-- valor, então toda row que passava continua passando.
--
-- ------------------------------------------------------------------
-- (A) POR QUE `dead_letter` E NÃO `failed_terminal`
-- ------------------------------------------------------------------
-- #506 §Estados sugeridos deu à 121 o vocabulário do CICLO DE ENTREGA. Ele
-- tem `failed_terminal`, e a tentação é reusá-lo para o esgotamento de
-- tentativas. Os dois fatos são diferentes, e a diferença é OPERACIONAL:
--
--   `failed_terminal`  — o PROVEDOR recusou de forma definitiva
--                        (`rejected_terminal`: payload inválido, bloqueio,
--                        destinatário inexistente). Rearmar é um loop: a
--                        próxima tentativa recebe a mesma recusa.
--   `dead_letter`      — NÓS desistimos. Ou o teto de tentativas estourou,
--                        ou a reconciliação de uma linha incerta venceu o
--                        prazo sem desfecho. A causa pode ter passado
--                        (rede, sessão do WhatsApp caída), então o
--                        rearmamento MANUAL é legítimo — e é exatamente o
--                        que a issue pede ("rearmamento manual com
--                        confirmação de risco e auditoria").
--
-- Colapsar os dois faria a listagem da DLQ trazer linhas que NUNCA devem
-- ser rearmadas misturadas com as que devem, e o operador — que age às 3h
-- da manhã — teria de reconstruir a distinção a partir de
-- `last_error_code`. Um estado é um predicado indexável; um código de erro
-- livre é arqueologia.
--
-- O nome NÃO é novo no repositório: `agent_turns.status = 'dead_letter'`
-- (097, issue #503) é a DLQ do ESTADO do turno, e `npm run dlq
-- replay-turn` já é o comando que a ressuscita. Um operador que conhece um
-- não precisa aprender o outro.
--
-- `dead_letter` é TERMINAL para o worker de entrega: não está em
-- `DELIVERY_CLAIMABLE_STATUSES` nem em `DELIVERY_TAKEOVER_STATUSES`
-- (src/runtime/outbound/delivery-contract.ts), então nenhum claim a
-- alcança. A única porta de saída é o rearmamento manual auditado.
--
-- ------------------------------------------------------------------
-- (B) TRANSAÇÃO E LOCK — por que este arquivo NÃO é `no-transaction`
-- ------------------------------------------------------------------
-- Sem o marcador `-- maia:no-transaction`, o runner (src/migrations/runner.ts)
-- envolve o arquivo inteiro em BEGIN/COMMIT: ou os três objetos existem, ou
-- nenhum existe. Isso importa aqui mais que o custo do lock, porque o
-- estado `dead_letter` sem os índices da varredura produziria uma DLQ que
-- ninguém alimenta, e os índices sem o estado produziriam uma varredura
-- que não tem para onde mandar o resultado.
--
-- O custo do lock, medido pela FORMA e não por opinião:
--
--  - `ALTER TABLE ... DROP/ADD CONSTRAINT ... CHECK` toma ACCESS EXCLUSIVE e
--    VARRE a tabela. É o mesmo movimento que a 121 fez SEIS vezes no mesmo
--    arquivo transacional, e o limite continua sendo o mesmo: sob a
--    retenção de 30 dias que o sweeper legado aplica
--    (`OUTBOUND_SWEEPER_RETENTION_DAYS`), `outbound_messages` é uma tabela
--    de trabalho recente, não um histórico ilimitado. Uma instalação onde
--    ela seja grande a ponto de a varredura importar deve aplicar este
--    arquivo em janela — e a alternativa (`ADD ... NOT VALID` + `VALIDATE`
--    numa segunda transação) exigiria quebrar a atomicidade acima, o que é
--    a troca errada para um CHECK que só AFROUXA.
--
--  - `CREATE INDEX` (não-concorrente) toma SHARE: bloqueia escrita, libera
--    leitura. Os dois índices são PARCIAIS sobre estados que NENHUMA row
--    legada pode ter (a 063 só admitia pending/sent/failed/unknown), então
--    o conjunto indexado no apply é exatamente o trabalho EM VOO do outbox
--    durável — hoje, zero ou quase. O build é uma varredura sem inserção.
--    O precedente para CONCURRENTLY numa `outbound_messages` grande é a
--    067, e ela é o caminho a copiar se algum dia essa varredura importar.
-- =====================================================================

-- ------------------------------------------------------------------
-- (1) O estado terminal da desistência.
--
--     A lista abaixo é a da 121 (6a) MAIS `dead_letter`, e espelha
--     `OUTBOUND_STATUSES` em src/runtime/outbound/contract.ts. Divergir
--     SQL↔TS reprova no CI (tests/integration/outbound-durable-outbox-
--     schema-real-db.spec.ts varre as duas listas).
--
--     O DROP + ADD é o mesmo movimento da 121 e é idempotente: reaplicar
--     o arquivo recria a constraint com a mesma definição.
-- ------------------------------------------------------------------
ALTER TABLE outbound_messages DROP CONSTRAINT IF EXISTS outbound_messages_status_check;
ALTER TABLE outbound_messages
  ADD CONSTRAINT outbound_messages_status_check CHECK (
    status IN (
      -- legado 063 (caminho síncrono de src/agent/output-dispatch.ts)
      'pending', 'sent', 'failed', 'unknown',
      -- outbox durável #506 (121)
      'claimed', 'sending', 'delivered', 'completed',
      'retryable', 'delivery_unknown', 'reconciling',
      'failed_terminal', 'cancelled',
      -- #633: NÓS desistimos. Ver o bloco (A) no topo.
      'dead_letter'
    )
  );

-- ------------------------------------------------------------------
-- (2) VARREDURA DE TAKEOVER — a lacuna que a #632 mandou fechar.
--
--     A consulta é literalmente esta, nos dois consumidores:
--
--       WHERE status IN ('claimed','sending') AND lease_expires_at <= now()
--
--     e ela aparece em DOIS regimes que pedem coisas opostas do índice:
--
--       (a) o DISPATCHER do sweeper roda FORA de contexto de tenant e
--           pergunta "que pares (tenant, agent) têm claim vencido?" — sem
--           igualdade em `tenant_id` para ancorar a sondagem;
--       (b) a varredura ESCOPADA roda dentro de um par e acrescenta
--           `tenant_id = $1 AND agent_id = $2`.
--
--     Por isso a ordem das colunas é `(lease_expires_at, tenant_id,
--     agent_id)` e NÃO a do índice de trabalho da 121 (7c), que começa por
--     tenant. Com `tenant_id` na frente, o predicado de (a) não tem prefixo
--     utilizável e o planejador cai em Seq Scan na tabela mais quente do
--     caminho de resposta — foi exatamente o diagnóstico que a 114 fez para
--     `agent_turns` (`agent_turns_lease_expiry_idx`), e este índice é o
--     mesmo desenho.
--
--     `tenant_id`/`agent_id` entram como colunas SEGUINTES (e não ficam de
--     fora, como na 114): (a) faz `SELECT DISTINCT tenant_id, agent_id`, que
--     assim sai do próprio índice, e (b) filtra o par sem ir ao heap.
--
--     Estado no PREDICADO e não na chave, como na 121 (7c): são dois
--     valores, o índice fica menor, e nenhuma row terminal — a maioria da
--     tabela — é indexada. `lease_expires_at IS NOT NULL` é redundante com
--     o CHECK `outbound_messages_claim_complete_check` (uma linha em
--     claimed/sending tem o trio de claim inteiro), e está aqui pela mesma
--     razão que está na 114: torna o índice imune a uma futura row
--     meio-preenchida em vez de depender da constraint continuar existindo.
-- ------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_outbound_messages_expired_claims
  ON outbound_messages (lease_expires_at, tenant_id, agent_id)
  WHERE status IN ('claimed', 'sending') AND lease_expires_at IS NOT NULL;

-- ------------------------------------------------------------------
-- (3) FILA DE RECONCILIAÇÃO — o produto principal desta fatia.
--
--     `delivery_unknown` é o estado que a #632 passou a PRODUZIR em volume
--     (`accepted_unconfirmed` deixou de virar `delivered`) e que ninguém
--     consumia. Ele não está em nenhum índice da 121: nem no de trabalho
--     (7c, parcial em pending/retryable) nem nos uniques.
--
--     Os três estados do predicado são a fila inteira, e cada um está aqui
--     por um motivo próprio:
--
--       `delivery_unknown` — a entrega terminou sem que se saiba se chegou.
--       `reconciling`      — já triada, aguardando decisão humana. Continua
--                            na fila porque um `reconciling` que envelhece
--                            é o alarme, não o repouso.
--       `delivered`        — a JANELA declarada pela #632: um crash entre
--                            `delivered` e `completed` deixa a mensagem
--                            entregue e o histórico faltando. A linha NÃO
--                            volta a ser reivindicável (e não deve: reenviar
--                            duplicaria), então quem a recupera é a
--                            reconciliação. Sem ela neste índice, o único
--                            jeito de achá-la seria varrer a tabela.
--
--     O eixo é `created_at`: `outbound_messages` não tem `updated_at`, e
--     inventá-lo aqui obrigaria toda gravação do caminho quente (#632) a
--     carimbá-lo. `created_at` responde à pergunta que o operador de fato
--     faz — "há quanto tempo esta resposta existe sem ter chegado?" —, é a
--     mesma base de `maia_outbound_pending_age_seconds`, e cobre ao mesmo
--     tempo o `ORDER BY` (mais antiga primeiro) e o corte por idade.
-- ------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_outbound_messages_reconcile
  ON outbound_messages (created_at, tenant_id, agent_id)
  WHERE status IN ('delivery_unknown', 'reconciling', 'delivered');

-- ------------------------------------------------------------------
-- (4) Catálogo. O operador que der `\d+ outbound_messages` às 3h da manhã
--     lê isto, não o git blame.
-- ------------------------------------------------------------------
COMMENT ON INDEX idx_outbound_messages_expired_claims IS
  'Issue #633: varredura de TAKEOVER (claim com lease vencida). lease_expires_at na FRENTE de proposito — o dispatcher cross-tenant do sweeper nao tem igualdade em tenant_id para ancorar a sondagem; mesmo desenho de agent_turns_lease_expiry_idx (114).';
COMMENT ON INDEX idx_outbound_messages_reconcile IS
  'Issue #633: fila de RECONCILIACAO. delivery_unknown (entrega incerta), reconciling (triada, aguardando humano) e delivered (janela delivered->completed declarada pela #632: mensagem entregue, historico faltando).';
