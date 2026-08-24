-- maia:no-transaction
-- 119 — índices e constraints da identidade de stream (issue #505, fases 1–2).
--
-- Separada da 118 pela MESMA razão que a 096 foi separada da 097: `mensagens` é
-- a maior tabela quente do runtime, e tudo aqui varre a tabela. Construir
-- índice ou validar CHECK dentro da transação do runner reteria o lock durante
-- a varredura inteira — janela de perda de ingresso. Daí o marcador
-- `maia:no-transaction`: o runner envia um statement por vez, em autocommit,
-- e cada varredura corre sob o lock mais fraco que o Postgres admite.
--
-- Restrição do runner nesse modo: só statements simples terminados por `;`
-- (sem `DO $$`, sem literal contendo `;`). Todos abaixo são idempotentes, então
-- reaplicar o arquivo após um crash é seguro.
--
-- ─── Por que CHECK em duas fases (NOT VALID, depois VALIDATE) ──────────────
--
-- `ALTER TABLE … ADD CONSTRAINT … CHECK (…)` numa só tacada toma ACCESS
-- EXCLUSIVE **e** varre a tabela inteira sob ele. `NOT VALID` separa as duas
-- coisas: a adição é só catálogo (lock curto, sem varredura) e JÁ protege todo
-- INSERT/UPDATE a partir daquele instante — `NOT VALID` dispensa a varredura
-- das linhas ANTIGAS, não a checagem das novas. O `VALIDATE` seguinte faz a
-- varredura sob SHARE UPDATE EXCLUSIVE, que NÃO conflita com ROW EXCLUSIVE:
-- o ingresso continua escrevendo enquanto ela roda. É o mesmo raciocínio (e a
-- mesma armadilha evitada) da migration 115.
--
-- Aqui a varredura é trivialmente barata — todas as linhas existentes têm as
-- colunas NULL e os predicados são `IS NULL`-tolerantes — mas a FORMA importa
-- mais que o custo de hoje: se alguém reaplicar este arquivo depois do
-- backfill de uma fase futura, a varredura já será real.
--
-- ─── A armadilha da lógica ternária (a mesma que a 097 documenta) ──────────
--
-- Um CHECK do Postgres só REPROVA quando o predicado avalia para FALSE. Se
-- avaliar para NULL, a linha é ACEITA. Por isso nenhum predicado abaixo compara
-- valores possivelmente nulos sem antes fixar a nulidade: cada conjunção usa
-- `(x IS NULL) = (y IS NULL)` — que é SEMPRE booleano — como guarda, e as
-- comparações de ordem ficam atrás de um `IS NULL OR`. Com a guarda em FALSE, o
-- `AND` inteiro é FALSE mesmo que o outro operando seja NULL, então uma linha
-- meio-preenchida não escapa.

-- ── mensagens: coerência do trio (chave, versão, sequência) ─────────────────
--
-- Um ingresso ou tem os TRÊS campos ou não tem NENHUM. Meio-preenchido é o
-- estado que faria uma leitura futura acreditar numa stream sem sequência (ou
-- numa sequência sem stream) — e é o estado que um caller distraído produz.
ALTER TABLE mensagens DROP CONSTRAINT IF EXISTS mensagens_stream_shadow_chk;

ALTER TABLE mensagens ADD CONSTRAINT mensagens_stream_shadow_chk CHECK (
  (stream_key IS NULL) = (stream_key_version IS NULL)
  AND (stream_key IS NULL) = (ingress_seq IS NULL)
  AND (ingress_seq IS NULL OR ingress_seq >= 1)
  AND (stream_key IS NULL OR length(stream_key) > 0)
) NOT VALID;

ALTER TABLE mensagens VALIDATE CONSTRAINT mensagens_stream_shadow_chk;

-- ── agent_turns: coerência da stream + fronteiras bem formadas ──────────────
--
-- `first_ingress_seq <= last_ingress_seq` é a invariante que separa "turno
-- simples" (iguais) de "turno agregado" (intervalo) e impede o intervalo
-- invertido, que passaria despercebido em toda leitura e só apareceria como
-- um head-of-line que nunca avança.
--
-- Fronteira exige stream: um turno com sequências e sem `stream_key` seria uma
-- ordem sem eixo — números comparáveis com nada.
ALTER TABLE agent_turns DROP CONSTRAINT IF EXISTS agent_turns_stream_shadow_chk;

ALTER TABLE agent_turns ADD CONSTRAINT agent_turns_stream_shadow_chk CHECK (
  (stream_key IS NULL) = (stream_key_version IS NULL)
  AND (first_ingress_seq IS NULL) = (last_ingress_seq IS NULL)
  AND (first_ingress_seq IS NULL OR stream_key IS NOT NULL)
  AND (first_ingress_seq IS NULL OR first_ingress_seq >= 1)
  AND (first_ingress_seq IS NULL OR last_ingress_seq >= first_ingress_seq)
  AND (stream_key IS NULL OR length(stream_key) > 0)
) NOT VALID;

ALTER TABLE agent_turns VALIDATE CONSTRAINT agent_turns_stream_shadow_chk;

-- ── Unicidade de (tenant, agent, stream_key, ingress_seq) ───────────────────
--
-- A invariante central da §Sequência de ingresso: dentro de uma stream, uma
-- sequência pertence a UM ingresso. É esta unique — e não o contador — que
-- torna a duplicação IMPOSSÍVEL: o contador é a alocação BEM-COMPORTADA, e
-- todo alocador tem um caminho de erro (backfill, replay manual, um segundo
-- alocador que alguém escreva depois). A unique é o que transforma esse
-- caminho de erro em violação visível em vez de reordenação silenciosa.
--
-- PARCIAL em `stream_key IS NOT NULL`: o histórico anterior ao protocolo (e
-- todo o outbound, `direcao = 'out'`, que nunca recebe stream) fica fora do
-- índice. Ele custa proporcionalmente ao ingresso SEQUENCIADO, não à tabela.
--
-- O prefixo `(tenant_id, agent_id, stream_key)` é deliberado e é também o
-- ÍNDICE DE SUPORTE que a issue pede (§Implementation Notes: "Índice provável
-- deve começar por tenant_id, agent_id, stream_key"): a mesma estrutura serve
-- à unicidade e às consultas "qual o próximo ingresso desta stream?" /
-- "quantos ingressos pendentes esta stream tem?" das fases seguintes. Um
-- segundo índice com o mesmo prefixo seria custo de escrita sem leitura nova.
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS mensagens_stream_ingress_uq
  ON mensagens (tenant_id, agent_id, stream_key, ingress_seq)
  WHERE stream_key IS NOT NULL;

-- ── Head-of-line por stream (o consumidor das fases 5–6) ────────────────────
--
-- A pergunta que a #505 vai fazer no claim é "existe turno ANTERIOR não
-- terminal nesta stream?", e ela é um `NOT EXISTS` sobre
-- (tenant, agent, stream_key) ordenado por `first_ingress_seq`. Sem este
-- índice esse predicado degrada em scan — o risco que a issue nomeia
-- explicitamente (§Risk: "índice inadequado pode serializar hot streams").
--
-- O índice é criado AGORA, na fase shadow, de propósito: construí-lo junto com
-- a ativação do enforcement somaria uma construção de índice a uma mudança de
-- comportamento, na mesma janela. `status` entra como coluna incluída na
-- ordenação para que o `NOT EXISTS` filtre sem visitar a heap.
CREATE INDEX CONCURRENTLY IF NOT EXISTS agent_turns_stream_head_idx
  ON agent_turns (tenant_id, agent_id, stream_key, first_ingress_seq, status)
  WHERE stream_key IS NOT NULL;
