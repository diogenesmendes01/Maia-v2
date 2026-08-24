-- =====================================================================
-- Maia — Migration 121 (Issue #630 — fatia A da épica #506)
--
-- Evolui o ledger `outbound_messages` (063/067) para o OUTBOX DURÁVEL do
-- turno. ADITIVA e REVERSÍVEL: nenhuma coluna existente muda de tipo, de
-- nulabilidade ou de default, nenhuma row é reescrita, e NADA passa a ser
-- enviado por caminho novo — as fatias irmãs (#631 commit transacional,
-- #632 delivery worker, #633 recovery/DLQ, #634 call sites) é que ligam a
-- máquina. Esta migração é schema + contrato.
--
-- POR QUE EVOLUIR EM VEZ DE CRIAR UM SEGUNDO LEDGER
-- -------------------------------------------------
-- `outbound_messages` já é a autoridade sobre "esta resposta saiu?" no
-- caminho síncrono (src/agent/output-dispatch.ts → outboundMessagesRepo).
-- Um segundo ledger criaria DUAS autoridades sobre o mesmo fato e a janela
-- de divergência entre elas seria exatamente o double-send que a #227
-- fechou. As tabelas vizinhas continuam distintas e NÃO são tocadas aqui:
--   - `outbox_messages`      — fila assíncrona de agendamento (Spec 18);
--   - `idempotency_effect_outbox` (068–070) — efeito externo de uma
--     RESERVA de idempotência de tool. É dele que esta migração herda o
--     formato de outbox (status + attempt + next_attempt_at + provider_ref
--     + unique por (tenant, agent, chave)); o padrão é copiado, não
--     reinventado.
--
-- ------------------------------------------------------------------
-- O RISCO DECLARADO NA MÃE — E POR QUE ELE NÃO SE MATERIALIZA AQUI
-- ------------------------------------------------------------------
-- #506 §Risk: "Constraints em tabela existente podem falhar com duplicatas
-- históricas." É o risco certo: um `CREATE UNIQUE INDEX` sobre uma coluna
-- JÁ POPULADA aborta a migração inteira se houver duplicata, e o operador
-- descobre isso em produção, no meio da janela.
--
-- Aqui ele é estruturalmente impossível, e a razão é verificável sem banco:
--
--   1. `logical_dedupe_key`, `turn_id` e `sequence_in_turn` são colunas
--      NOVAS. `ALTER TABLE ... ADD COLUMN` sem DEFAULT deixa TODA row
--      existente com NULL. Nenhuma row histórica pode ter valor.
--   2. Os dois uniques são PARCIAIS (`WHERE ... IS NOT NULL`). Uma row
--      legada não satisfaz o predicado, logo não entra no índice, logo não
--      pode colidir com nada. O conjunto indexado no momento do apply é
--      VAZIO — o build é uma varredura sem inserção.
--   3. Esta migração NÃO faz backfill. Deliberadamente: derivar
--      `logical_dedupe_key` de linhas antigas exigiria inventar `turn_id`
--      para respostas anteriores à #503, e #506 §Backfill manda classificar
--      row legada por nível de confiança em vez de promovê-la em massa.
--
-- Um unique PARCIAL não é só uma otimização: é o que troca "pode explodir
-- em produção com dado que eu não consigo inspecionar" por "não existe
-- entrada possível para explodir".
--
-- Mesmo assim, o bloco DO $$ abaixo pré-checa e RAISE com mensagem
-- ACIONÁVEL (conta as duplicatas e nomeia o escopo) em vez de deixar o
-- erro genérico de índice único aparecer. Se alguém aplicar esta migração
-- DEPOIS de um backfill de outra branch, a falha diz o que fazer.
--
-- Inventário manual, se você tiver o banco (esta árvore não tem — Postgres
-- fora do ar; ver o relatório da issue):
--   SELECT count(*) AS total,
--          count(*) FILTER (WHERE turn_id IS NOT NULL) AS com_turn,
--          count(*) FILTER (WHERE logical_dedupe_key IS NOT NULL) AS com_ldk
--     FROM outbound_messages;
--   -- (só faz sentido DEPOIS de 121; antes as colunas nem existem)
--
-- ------------------------------------------------------------------
-- TRANSAÇÃO E LOCK
-- ------------------------------------------------------------------
-- Arquivo SEM `-- maia:no-transaction`: o runner (src/migrations/runner.ts)
-- envolve tudo em BEGIN/COMMIT, então ou o outbox inteiro existe ou nada
-- existe. `CREATE INDEX` não-concorrente pega SHARE (bloqueia escrita,
-- libera leitura) e `ALTER TABLE ADD COLUMN` sem default pega ACCESS
-- EXCLUSIVE mas NÃO reescreve a tabela (PG11+). Como os índices novos são
-- parciais sobre predicado que nenhuma row legada satisfaz, o build é uma
-- varredura sem ordenação/inserção. Para uma instalação onde
-- `outbound_messages` seja grande a ponto de a varredura importar, o
-- caminho é uma migração no-tx separada com CONCURRENTLY, como a 067 fez —
-- e a 067 é o precedente a copiar.
-- =====================================================================

-- ------------------------------------------------------------------
-- (0) Pré-checagem legível. Nada abaixo pode falhar hoje (as colunas não
--     existem ainda), mas se uma re-aplicação encontrar a tabela já
--     evoluída E com duplicata (backfill de outra branch), a mensagem
--     precisa dizer QUAL escopo duplicou, não "duplicate key value".
-- ------------------------------------------------------------------
DO $$
DECLARE
  dup_count bigint;
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_name = 'outbound_messages' AND column_name = 'logical_dedupe_key'
  ) THEN
    EXECUTE $q$
      SELECT count(*) FROM (
        SELECT 1 FROM outbound_messages
         WHERE logical_dedupe_key IS NOT NULL
         GROUP BY tenant_id, agent_id, logical_dedupe_key
        HAVING count(*) > 1
      ) d
    $q$ INTO dup_count;
    IF dup_count > 0 THEN
      RAISE EXCEPTION
        '121: % escopo(s) (tenant_id, agent_id, logical_dedupe_key) com mais de uma row em outbound_messages. O unique parcial outbound_messages_logical_dedupe_uq NAO pode ser criado. Inventarie com: SELECT tenant_id, agent_id, logical_dedupe_key, count(*) FROM outbound_messages WHERE logical_dedupe_key IS NOT NULL GROUP BY 1,2,3 HAVING count(*) > 1; e reconcilie MANUALMENTE (issue #506 secao Backfill: classificar row legada por confianca, NUNCA reenviar por ausencia de status) antes de reaplicar.',
        dup_count;
    END IF;
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_name = 'outbound_messages' AND column_name = 'turn_id'
  ) THEN
    EXECUTE $q$
      SELECT count(*) FROM (
        SELECT 1 FROM outbound_messages
         WHERE turn_id IS NOT NULL
         GROUP BY tenant_id, agent_id, turn_id, sequence_in_turn
        HAVING count(*) > 1
      ) d
    $q$ INTO dup_count;
    IF dup_count > 0 THEN
      RAISE EXCEPTION
        '121: % escopo(s) (tenant_id, agent_id, turn_id, sequence_in_turn) com mais de uma row em outbound_messages. O unique parcial outbound_messages_turn_sequence_uq NAO pode ser criado. Duas saidas logicas do MESMO turno reivindicaram a MESMA posicao — reconcilie manualmente antes de reaplicar.',
        dup_count;
    END IF;
  END IF;
END $$;

-- ------------------------------------------------------------------
-- (1) Identidade do turno. `turn_id` amarra a saída lógica ao turno de
--     #503; `sequence_in_turn` ordena as saídas de uma resposta multipart
--     (a política de multipart em si é #635 — aqui só existe o eixo).
--
--     FK COMPOSTA por (tenant_id, agent_id, turn_id): o alvo é
--     `agent_turns_scope_id_uq UNIQUE (tenant_id, agent_id, id)`, criado
--     pela 097 exatamente para isso. Uma FK só em `turn_id` deixaria uma
--     row do tenant A apontar para o turno do tenant B — a FK composta
--     torna o vazamento IMPOSSÍVEL POR CONSTRUÇÃO, não por disciplina de
--     código. ON DELETE RESTRICT: apagar um turno que tem outbound
--     pendente é exatamente o que não pode acontecer em silêncio.
-- ------------------------------------------------------------------
ALTER TABLE outbound_messages ADD COLUMN IF NOT EXISTS turn_id uuid;
ALTER TABLE outbound_messages ADD COLUMN IF NOT EXISTS sequence_in_turn integer;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'outbound_messages_turn_scope_fk'
  ) THEN
    ALTER TABLE outbound_messages
      ADD CONSTRAINT outbound_messages_turn_scope_fk
      FOREIGN KEY (tenant_id, agent_id, turn_id)
      REFERENCES agent_turns (tenant_id, agent_id, id)
      ON DELETE RESTRICT;
  END IF;
END $$;

-- ------------------------------------------------------------------
-- (2) Payload tipado, versionado e imutável.
--
--     `payload_version` — versão da UNIÃO e da SERIALIZAÇÃO CANÔNICA
--       (src/runtime/outbound/contract.ts, OUTBOUND_PAYLOAD_VERSION). É o
--       que permite trocar a forma canônica sem invalidar hash antigo: uma
--       row v1 continua verificável pela regra v1.
--     `payload_type`   — discriminante da união Zod. A lista fechada abaixo
--       espelha OUTBOUND_PAYLOAD_TYPES e é a MESMA que os testes de
--       contrato varrem, então divergir SQL↔TS reprova no CI.
--     `payload_json`   — só o necessário para reproduzir o envio.
--       Mídia entra por REFERÊNCIA (o contrato TS só admite
--       `{kind:'local_path'}` / `{kind:'storage_object'}`, jamais URL), de
--       modo que segredo, token e URL assinada de vida longa não têm forma
--       de chegar aqui: não existe variante do tipo que os aceite.
--     `payload_hash`   — sha256 hex da serialização canônica versionada.
--       64 hex, checado por CHECK — um hash truncado ou de outro algoritmo
--       é recusado pelo banco, não só pelo TS.
-- ------------------------------------------------------------------
ALTER TABLE outbound_messages ADD COLUMN IF NOT EXISTS payload_version integer;
ALTER TABLE outbound_messages ADD COLUMN IF NOT EXISTS payload_type text;
ALTER TABLE outbound_messages ADD COLUMN IF NOT EXISTS payload_json jsonb;
ALTER TABLE outbound_messages ADD COLUMN IF NOT EXISTS payload_hash text;

-- ------------------------------------------------------------------
-- (3) AS DUAS IDENTIDADES. Este é o ponto conceitual da fatia, e elas são
--     DISTINTAS por razões diferentes:
--
--     `logical_dedupe_key`       — "qual saída lógica é esta, DENTRO da
--       Maia". É a chave que impede que um retry do turno produza uma
--       SEGUNDA saída lógica: o unique parcial (7a) transforma "não
--       duplique" em invariante do banco em vez de disciplina do chamador.
--
--     `provider_idempotency_key` — "que identificador o ADAPTADOR usa". É o
--       `MiscMessageGenerationOptions.messageId` que o Baileys grava
--       verbatim na key da mensagem (src/gateway/baileys.ts, sendOutboundText),
--       e o WhatsApp chaveia mensagem por (remoteJid, fromMe, id) — então
--       ele é dedupe de VERDADE do lado do provedor, não decoração.
--
--     Por que não uma coluna só: a chave lógica é o eixo de unicidade da
--     Maia e pode ter o formato que quisermos; a do provedor tem que caber
--     no formato que o WhatsApp aceita (`3EB0` + 18 hex) e é ENTREGUE A UM
--     TERCEIRO. Se fossem a mesma string, ou a Maia perderia unicidade para
--     caber no formato alheio, ou entregaria ao provedor o identificador
--     que é a sua própria chave de dedupe. As duas são derivadas do MESMO
--     material canônico com separação de domínio diferente
--     (src/runtime/outbound/contract.ts): mesma origem, namespaces
--     disjuntos, e nenhuma das duas é invertível para tenant/telefone/
--     conteúdo — são digests, então logá-las não vaza identificador.
--
--     Ambas são derivadas SÓ de campo IMUTÁVEL (tenant, agent, turn,
--     sequence, payload_hash). Nunca de `attempt`, `status` ou timestamp:
--     uma chave que muda entre tentativas não é chave de idempotência, é
--     um contador com nome errado.
-- ------------------------------------------------------------------
ALTER TABLE outbound_messages ADD COLUMN IF NOT EXISTS logical_dedupe_key text;
ALTER TABLE outbound_messages ADD COLUMN IF NOT EXISTS provider_idempotency_key text;

-- ------------------------------------------------------------------
-- (4) Claim, lease e fencing — mesmo vocabulário de `agent_turns`
--     (097 + 114, issues #503/#504), de propósito: quem já leu o protocolo
--     do turno lê o do outbound sem traduzir. `claim_token` é o fence — a
--     mutação do worker antigo tem que ser recusada quando o token não
--     bate mais, o que é #632/#633; aqui existe a coluna e o formato.
--     O relógio é o DO BANCO (`now()`), nunca o do processo.
-- ------------------------------------------------------------------
ALTER TABLE outbound_messages ADD COLUMN IF NOT EXISTS attempt integer NOT NULL DEFAULT 0;
ALTER TABLE outbound_messages ADD COLUMN IF NOT EXISTS claimed_by text;
ALTER TABLE outbound_messages ADD COLUMN IF NOT EXISTS claim_token uuid;
ALTER TABLE outbound_messages ADD COLUMN IF NOT EXISTS lease_expires_at timestamptz;
ALTER TABLE outbound_messages ADD COLUMN IF NOT EXISTS next_attempt_at timestamptz;

-- ------------------------------------------------------------------
-- (5) Resultado do provedor. `provider_message_id` JÁ EXISTE desde a 063 e
--     é reaproveitada — criar uma segunda coluna com o mesmo significado
--     seria o mesmo erro de "segundo ledger" em escala de coluna.
--
--     `delivery_outcome` separa "o provedor aceitou" de "o usuário
--     recebeu", que a 063 colapsava no par status='sent'/'unknown'. A lista
--     fechada é a de #506 §Resultado do provider. `timeout_unknown` e
--     `cancelled_after_send_unknown` são os estados HONESTOS: retry
--     automático a partir deles é reenvio cego, e a política (#633) é
--     reconciliar, não reenviar.
-- ------------------------------------------------------------------
ALTER TABLE outbound_messages ADD COLUMN IF NOT EXISTS provider_timestamp timestamptz;
ALTER TABLE outbound_messages ADD COLUMN IF NOT EXISTS last_error_code text;
ALTER TABLE outbound_messages ADD COLUMN IF NOT EXISTS delivery_outcome text;

-- ------------------------------------------------------------------
-- (6) CHECKs.
--
--     ARMADILHA DA LÓGICA TERNÁRIA (documentada na 097, bug real pego pelo
--     CI na PR #532): um CHECK do Postgres só REPROVA quando o predicado dá
--     FALSE; se der NULL a row é ACEITA. Um `col IN (...)` com `col` NULL dá
--     NULL, não FALSE. Por isso todo CHECK abaixo ou é escrito como
--     `col IS NULL OR col IN (...)` — cuja primeira perna é sempre booleana
--     — ou usa CASE com IS NULL/IS NOT NULL. Nenhum caminho produz NULL.
-- ------------------------------------------------------------------

-- (6a) Estados. Os quatro da 063 continuam válidos (row legada não muda de
--      significado); os de #506 §Estados sugeridos entram ADITIVAMENTE. O
--      índice de seleção (7c) filtra 'retryable', que sem esta extensão
--      seria um estado que o CHECK proíbe — o índice apontaria para o vazio.
ALTER TABLE outbound_messages DROP CONSTRAINT IF EXISTS outbound_messages_status_check;
ALTER TABLE outbound_messages
  ADD CONSTRAINT outbound_messages_status_check CHECK (
    status IN (
      -- legado 063 (caminho síncrono de src/agent/output-dispatch.ts)
      'pending', 'sent', 'failed', 'unknown',
      -- outbox durável #506
      'claimed', 'sending', 'delivered', 'completed',
      'retryable', 'delivery_unknown', 'reconciling',
      'failed_terminal', 'cancelled'
    )
  );

-- (6b) Canal. `channel` é o eixo LEGADO (a primitiva de saída usada);
--      `payload_type` é o eixo novo e autoritativo. Estender o CHECK legado
--      é o mínimo para que uma reação ou um fallback sejam EXPRESSÁVEIS —
--      sem isso a #631 receberia um schema que não consegue registrar duas
--      das saídas que o LineOutput já sabe emitir
--      (src/gateway/line-output.ts: sendReaction).
ALTER TABLE outbound_messages DROP CONSTRAINT IF EXISTS outbound_messages_channel_check;
ALTER TABLE outbound_messages
  ADD CONSTRAINT outbound_messages_channel_check CHECK (
    channel IN ('text', 'voice', 'document', 'poll', 'reaction', 'status_fallback')
  );

-- (6c) Tipos de payload. Lista FECHADA, espelha OUTBOUND_PAYLOAD_TYPES em
--      src/runtime/outbound/contract.ts.
--
--      `image` e `video` NÃO estão aqui, e a ausência é deliberada: a
--      fronteira única de saída (src/gateway/line-output.ts, interface
--      LineOutput) declara sendText / sendDocument / sendVoice / sendPoll /
--      sendReaction — não há primitiva de imagem nem de vídeo. #506 §Out of
--      Scope proíbe "implementação de suporte a tipos que a plataforma
--      ainda não declara suportar", e admitir o tipo no schema criaria row
--      que NENHUM delivery worker consegue entregar: um pending eterno,
--      fail-OPEN disfarçado de completude.
--
--      `interactive` existe numa única forma real — a enquete. #630 manda
--      verificar em vez de presumir: o que a plataforma declara é
--      `sendPoll` (LineOutput), e é isso que `interactive_poll` nomeia.
--      Botões e listas não têm primitiva e por isso não têm valor aqui.
ALTER TABLE outbound_messages DROP CONSTRAINT IF EXISTS outbound_messages_payload_type_check;
ALTER TABLE outbound_messages
  ADD CONSTRAINT outbound_messages_payload_type_check CHECK (
    payload_type IS NULL OR payload_type IN (
      'text', 'audio', 'document', 'reaction', 'interactive_poll', 'status_fallback'
    )
  );

-- (6d) Resultado normalizado do provedor (#506 §Resultado do provider).
ALTER TABLE outbound_messages DROP CONSTRAINT IF EXISTS outbound_messages_delivery_outcome_check;
ALTER TABLE outbound_messages
  ADD CONSTRAINT outbound_messages_delivery_outcome_check CHECK (
    delivery_outcome IS NULL OR delivery_outcome IN (
      'accepted_confirmed', 'accepted_unconfirmed',
      'rejected_retryable', 'rejected_terminal',
      'timeout_unknown', 'cancelled_before_send', 'cancelled_after_send_unknown'
    )
  );

-- (6e) COMPLETUDE DA ROW NOVA. Este é o CHECK que faz "aditivo" não virar
--      "opcional": row LEGADA (turn_id NULL) segue exatamente como estava,
--      row NOVA (turn_id NOT NULL) tem que trazer o tuplo durável INTEIRO.
--      Sem ele, a #631 poderia gravar meia row — com turn_id e sem
--      payload_hash, por exemplo — e a chave lógica ficaria inderivável
--      justamente na row que ela existe para proteger.
--
--      Escrito com CASE + IS NULL/IS NOT NULL (nunca `IN`) pela armadilha
--      ternária acima. tenant_id/agent_id não aparecem porque já são NOT
--      NULL na tabela desde a 063 — o critério de pronto de #630 ("nenhum
--      campo de tenant/agent nullable ou inferido por fallback em registro
--      novo") já está satisfeito pela coluna, não precisa de CHECK.
ALTER TABLE outbound_messages DROP CONSTRAINT IF EXISTS outbound_messages_durable_row_complete_check;
ALTER TABLE outbound_messages
  ADD CONSTRAINT outbound_messages_durable_row_complete_check CHECK (
    CASE WHEN turn_id IS NULL THEN true ELSE (
      sequence_in_turn IS NOT NULL
      AND payload_version IS NOT NULL
      AND payload_type IS NOT NULL
      AND payload_json IS NOT NULL
      AND payload_hash IS NOT NULL
      AND logical_dedupe_key IS NOT NULL
      AND provider_idempotency_key IS NOT NULL
      AND next_attempt_at IS NOT NULL
    ) END
  );

-- (6f) Domínios escalares.
ALTER TABLE outbound_messages DROP CONSTRAINT IF EXISTS outbound_messages_sequence_in_turn_check;
ALTER TABLE outbound_messages
  ADD CONSTRAINT outbound_messages_sequence_in_turn_check CHECK (
    sequence_in_turn IS NULL OR sequence_in_turn >= 0
  );
ALTER TABLE outbound_messages DROP CONSTRAINT IF EXISTS outbound_messages_attempt_check;
ALTER TABLE outbound_messages
  ADD CONSTRAINT outbound_messages_attempt_check CHECK (attempt >= 0);
ALTER TABLE outbound_messages DROP CONSTRAINT IF EXISTS outbound_messages_payload_version_check;
ALTER TABLE outbound_messages
  ADD CONSTRAINT outbound_messages_payload_version_check CHECK (
    payload_version IS NULL OR payload_version >= 1
  );
-- sha256 em hex minúsculo. O banco recusa hash truncado, maiúsculo ou de
-- outro algoritmo — a verificação não fica só no TS.
ALTER TABLE outbound_messages DROP CONSTRAINT IF EXISTS outbound_messages_payload_hash_format_check;
ALTER TABLE outbound_messages
  ADD CONSTRAINT outbound_messages_payload_hash_format_check CHECK (
    payload_hash IS NULL OR payload_hash ~ '^[0-9a-f]{64}$'
  );
-- Códigos de erro são de BAIXA cardinalidade e sanitizados. O teto espelha
-- agent_turns_error_code_len_chk (097): é o vetor por onde payload/PII
-- vazaria para a trilha se alguém jogasse a mensagem crua aqui.
ALTER TABLE outbound_messages DROP CONSTRAINT IF EXISTS outbound_messages_last_error_code_len_check;
ALTER TABLE outbound_messages
  ADD CONSTRAINT outbound_messages_last_error_code_len_check CHECK (
    last_error_code IS NULL OR length(last_error_code) <= 64
  );
-- Teto de tamanho do payload persistido (#506 §Implementation Notes:
-- "definir limites de payload"). 256 KiB é ordens de grandeza acima de
-- qualquer texto/legenda legítimo e ordens de grandeza abaixo de um blob —
-- é a linha que separa "referência de mídia" de "mídia dentro do Postgres",
-- que #506 §Out of Scope proíbe explicitamente.
--
-- `octet_length(payload_json::text)` e NÃO `pg_column_size(payload_json)`:
-- `pg_column_size` é declarada STABLE, não IMMUTABLE, e o quanto o Postgres
-- tolera função não-imutável dentro de CHECK varia por versão. Uma migração
-- que pode ser recusada no apply por causa da volatilidade de uma função
-- auxiliar é exatamente o tipo de falha que não se quer descobrir na janela.
-- O cast jsonb→text (`jsonb_out`) e `octet_length` são IMUTÁVEIS, então este
-- predicado é aceito em qualquer versão. Mede a forma textual canônica do
-- JSONB em bytes, que é o número que interessa aqui (é o payload lógico, não
-- o custo de armazenamento pós-TOAST — e o limite é sobre o payload).
ALTER TABLE outbound_messages DROP CONSTRAINT IF EXISTS outbound_messages_payload_json_size_check;
ALTER TABLE outbound_messages
  ADD CONSTRAINT outbound_messages_payload_json_size_check CHECK (
    payload_json IS NULL OR octet_length(payload_json::text) <= 262144
  );
-- Fencing coerente: ou o trio de claim está inteiro, ou não há claim. Um
-- `claimed_by` sem `claim_token` é um dono que não pode ser cercado.
ALTER TABLE outbound_messages DROP CONSTRAINT IF EXISTS outbound_messages_claim_complete_check;
ALTER TABLE outbound_messages
  ADD CONSTRAINT outbound_messages_claim_complete_check CHECK (
    CASE WHEN claim_token IS NULL THEN claimed_by IS NULL AND lease_expires_at IS NULL
         ELSE claimed_by IS NOT NULL AND lease_expires_at IS NOT NULL END
  );

-- ------------------------------------------------------------------
-- (7) Índices.
-- ------------------------------------------------------------------

-- (7a) UNIQUE da identidade lógica. PARCIAL — ver o bloco do risco no topo:
--      é o predicado `IS NOT NULL` que torna a criação imune a duplicata
--      histórica, porque nenhuma row legada entra no índice.
CREATE UNIQUE INDEX IF NOT EXISTS outbound_messages_logical_dedupe_uq
  ON outbound_messages (tenant_id, agent_id, logical_dedupe_key)
  WHERE logical_dedupe_key IS NOT NULL;

-- (7b) UNIQUE da posição no turno. Duas saídas lógicas não podem
--      reivindicar a mesma posição do mesmo turno. Também PARCIAL.
--      É a rede independente de (7a): (7a) protege contra "mesmo conteúdo
--      duas vezes", (7b) protege contra "mesma posição com conteúdo
--      diferente" — que (7a) deixaria passar, porque payload_hash entra na
--      derivação e conteúdo diferente gera chave diferente.
CREATE UNIQUE INDEX IF NOT EXISTS outbound_messages_turn_sequence_uq
  ON outbound_messages (tenant_id, agent_id, turn_id, sequence_in_turn)
  WHERE turn_id IS NOT NULL;

-- (7c) Seleção de trabalho do delivery worker (#632): por (tenant, agent),
--      as rows pendentes/retryable cujo gate de backoff já venceu, mais
--      antiga primeiro. As colunas de igualdade ancoram a sondagem e
--      `next_attempt_at` cobre AO MESMO TEMPO o predicado
--      `next_attempt_at <= now()` e o ORDER BY que o LIMIT percorre — o
--      mesmo desenho do índice do relayer (069). O status vai no PREDICADO
--      PARCIAL, não na chave: são exatamente dois valores, então o índice
--      fica menor e não indexa row terminal, que é a maioria da tabela sob
--      retenção de 30 dias.
CREATE INDEX IF NOT EXISTS idx_outbound_messages_ready
  ON outbound_messages (tenant_id, agent_id, next_attempt_at)
  WHERE status IN ('pending', 'retryable');

-- ------------------------------------------------------------------
-- (8) Documentação no catálogo — o operador que der \d+ no psql às 3h da
--     manhã lê isto, não o git blame.
-- ------------------------------------------------------------------
COMMENT ON COLUMN outbound_messages.turn_id IS
  'Issue #630/#506: turno (agent_turns) dono desta saida logica. NULL = row legada anterior ao outbox duravel. FK COMPOSTA (tenant_id, agent_id, turn_id) — uma row nunca aponta para turno de outro tenant.';
COMMENT ON COLUMN outbound_messages.sequence_in_turn IS
  'Issue #630: posicao da saida dentro do turno (0-based). Eixo de ordenacao do multipart; a politica de multipart e #635.';
COMMENT ON COLUMN outbound_messages.payload_version IS
  'Issue #630: versao da uniao Zod E da serializacao canonica (OUTBOUND_PAYLOAD_VERSION em src/runtime/outbound/contract.ts). Permite evoluir a forma canonica sem invalidar payload_hash antigo.';
COMMENT ON COLUMN outbound_messages.payload_type IS
  'Issue #630: discriminante da uniao. image/video ausentes de proposito — LineOutput nao declara primitiva para eles (#506 secao Out of Scope). interactive existe so como interactive_poll (sendPoll).';
COMMENT ON COLUMN outbound_messages.payload_json IS
  'Issue #630: payload validado. Midia entra por REFERENCIA (local_path/storage_object); o contrato TS nao tem variante que aceite URL, entao segredo/token/URL assinada nao tem forma de ser persistido aqui.';
COMMENT ON COLUMN outbound_messages.payload_hash IS
  'Issue #630: sha256 hex da serializacao canonica VERSIONADA do payload. Entra na derivacao das duas chaves — payload diferente nao reutiliza chave.';
COMMENT ON COLUMN outbound_messages.logical_dedupe_key IS
  'Issue #630: identidade da saida logica DENTRO da Maia. Derivada so de campo imutavel (tenant, agent, turn, sequence, payload_hash) com enquadramento por prefixo de comprimento. Digest — nao expoe tenant/telefone/conteudo. UNIQUE parcial por (tenant_id, agent_id, logical_dedupe_key).';
COMMENT ON COLUMN outbound_messages.provider_idempotency_key IS
  'Issue #630: chave estavel entregue ao ADAPTADOR (Baileys MiscMessageGenerationOptions.messageId). Mesmo material canonico da logical_dedupe_key, com separacao de dominio DIFERENTE: o provedor nunca recebe a chave de dedupe interna da Maia. Formato aceito pelo WhatsApp (3EB0 + 18 hex).';
COMMENT ON COLUMN outbound_messages.attempt IS
  'Issue #630: contador de tentativas de entrega. MUTAVEL — por isso NUNCA entra na derivacao de nenhuma das duas chaves.';
COMMENT ON COLUMN outbound_messages.claim_token IS
  'Issue #630: token de FENCING do delivery worker. Mesmo vocabulario de agent_turns.claim_token (097/114). Mutacao com token velho tem que ser recusada (#632).';
COMMENT ON COLUMN outbound_messages.next_attempt_at IS
  'Issue #630: gate de backoff. Relogio do BANCO (now()), nunca do processo. Coberto por idx_outbound_messages_ready.';
COMMENT ON COLUMN outbound_messages.delivery_outcome IS
  'Issue #630/#506: resultado NORMALIZADO do provedor. Separa "provedor aceitou" de "usuario recebeu". timeout_unknown e cancelled_after_send_unknown sao os estados honestos: reconciliacao (#633), nunca reenvio cego.';
