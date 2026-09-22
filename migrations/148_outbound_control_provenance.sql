-- 148 — A PROVENIÊNCIA DE CONTROLE do egresso (spec Maia+Hermes §8.2.4, C43).
--
-- ─── O buraco que esta migration fecha ─────────────────────────────────────
--
-- A U-P04.7a pôs fence de controle humano no COMMIT do outbound: o turno só
-- anda para `outbound_pending` com a conversa em modo `bot`. Isso fecha a
-- janela do commit e não fecha a seguinte, que é maior.
--
-- Entre o commit e o envio existe fila: a linha fica em `outbound_messages`
-- com `next_attempt_at`, e quem a envia é o drain, o recovery ou o takeover de
-- lease — minutos depois, às vezes. O operador que assume a conversa NESSE
-- intervalo tem a resposta do bot saindo por cima dele, e o fence do commit
-- não vê nada de errado: ele já rodou, e naquele instante estava tudo em modo
-- `bot`.
--
-- ─── Por que três colunas, e não um booleano ──────────────────────────────
--
-- `origin` responde "quem escreveu isto?". É a coluna que impede o remédio de
-- virar a doença: o fence precisa reter a fala do BOT e deixar passar a fala
-- do OPERADOR, e sem ela as duas são a mesma linha de `outbound_messages`. O
-- atendente que digita no console e não vê a mensagem sair é um jeito novo de
-- quebrar a mesma conversa.
--
-- `system` fica do lado retido, junto com `bot`, e não é descuido: um lembrete
-- automático disparando enquanto um humano atende é exatamente a plataforma
-- falando por cima dele. Só quem TEM o controle fala.
--
-- `control_epoch` responde "sob qual regime isto foi escrito?". Só o modo
-- atual não basta: pausa seguida de retomada devolve a conversa ao bot, e uma
-- resposta commitada ANTES da pausa responde a um estado da conversa que já
-- não existe — é o backlog que o §8.2.5 manda descartar em `future_only`.
-- Comparar epoch é como o envio distingue "a conversa está livre" de "a
-- conversa voltou a ficar livre DEPOIS de outra pessoa mexer nela".
--
-- `control_id` diz a QUAL controle o epoch se refere. Epoch é contador por
-- conversa; sem a linha a que pertence, comparar dois números seria comparar
-- réguas diferentes.
--
-- ─── Nullable, e por quê ──────────────────────────────────────────────────
--
-- `control_id`/`control_epoch` nascem NULL: as linhas existentes não têm como
-- ser ligadas retroativamente (nada nelas diz sob qual regime foram escritas),
-- e uma conversa que nunca foi pausada não tem linha de controle nenhuma — o
-- caso comum. NULL aqui significa "não havia controle", que é o mesmo que
-- modo `bot`, e é por isso que o predicado de egresso não as retém.
--
-- Quem retém de verdade é a outra metade do predicado, que olha o controle
-- VIVO da stream do turno — essa não depende de coluna nova e alcança também
-- as linhas legadas. Ver `outboundEgressAuthorizedSql`.
--
-- `origin` nasce NOT NULL DEFAULT 'bot' porque toda linha anterior a esta
-- migration foi escrita pela automação: é afirmação verdadeira, não default de
-- conveniência.
--
-- ─── Custo ────────────────────────────────────────────────────────────────
--
-- `ADD COLUMN` nullable e `ADD COLUMN ... DEFAULT` constante são metadata-only
-- desde o PG 11: nenhuma reescrita de tabela, e `outbound_messages` é quente.
-- O CHECK novo entra `NOT VALID` e é validado em statement próprio, pelo mesmo
-- motivo da 122 e da 135 — validar sob `ACCESS EXCLUSIVE` varreria a tabela
-- inteira.
--
-- Sem índice novo: o predicado de egresso alcança o controle por
-- `conversation_controls_stream_uq` (tenant, agent, stream_key), que a 140 já
-- criou, e a linha de `outbound_messages` já está localizada por PK quando o
-- claim a avalia.
--
-- ─── Sem envelope BEGIN/COMMIT, de propósito ──────────────────────────────
--
-- Mesmo desenho da 135. O `VALIDATE CONSTRAINT` precisa rodar FORA da
-- transação que adicionou a constraint: dentro dela, o `ACCESS EXCLUSIVE` do
-- `ADD` fica retido até o commit, e a varredura da tabela inteira aconteceria
-- sob ele — que é exatamente o que o `NOT VALID` existe para evitar.
--
-- Todo statement aqui é idempotente (`ADD COLUMN IF NOT EXISTS`, `DROP
-- CONSTRAINT IF EXISTS` antes de cada `ADD`, `VALIDATE` de constraint já
-- válida é no-op), então uma execução interrompida no meio é retomável sem
-- estado parcial que atrapalhe: colunas sem CHECK validado é correto, só
-- menos provado.

ALTER TABLE outbound_messages
  -- O controle em vigor quando a linha foi commitada. NULL = não havia.
  ADD COLUMN IF NOT EXISTS control_id uuid,
  -- O epoch daquele controle no instante do commit. Decimal grande: bigint.
  ADD COLUMN IF NOT EXISTS control_epoch bigint,
  -- Quem escreveu. `bot` para tudo que já existe, porque é o que de fato foi.
  ADD COLUMN IF NOT EXISTS origin text NOT NULL DEFAULT 'bot';

ALTER TABLE outbound_messages
  DROP CONSTRAINT IF EXISTS outbound_messages_origin_chk;

ALTER TABLE outbound_messages
  ADD CONSTRAINT outbound_messages_origin_chk
  CHECK (origin IN ('bot', 'operator', 'system'))
  NOT VALID;

ALTER TABLE outbound_messages
  DROP CONSTRAINT IF EXISTS outbound_messages_control_provenance_chk;

-- Coerência: os dois campos da proveniência andam juntos. Um epoch sem o
-- controle a que pertence é um número sem régua; um controle sem epoch não
-- responde "sob qual regime", que é a única pergunta que ele existe para
-- responder.
ALTER TABLE outbound_messages
  ADD CONSTRAINT outbound_messages_control_provenance_chk
  CHECK ((control_id IS NULL) = (control_epoch IS NULL))
  NOT VALID;

COMMENT ON COLUMN outbound_messages.origin IS
  'spec maia-hermes 8.2.4 (C43): quem escreveu a saida. bot|system sao retidos sob controle humano; operator passa, porque e a fala de quem TEM o controle.';

COMMENT ON COLUMN outbound_messages.control_id IS
  'conversation_controls em vigor no commit. NULL = nao havia controle (equivale a modo bot).';

COMMENT ON COLUMN outbound_messages.control_epoch IS
  'Epoch daquele controle no commit. Epoch diferente no envio = o regime da conversa mudou desde que esta resposta foi escrita.';

-- A varredura das linhas antigas, já fora do lock forte do ADD.
ALTER TABLE outbound_messages VALIDATE CONSTRAINT outbound_messages_origin_chk;
ALTER TABLE outbound_messages VALIDATE CONSTRAINT outbound_messages_control_provenance_chk;
