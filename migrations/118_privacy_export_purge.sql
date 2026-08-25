-- 118 — o TTL do export de privacidade deixa de ser um carimbo e passa a ter
-- execução (issue #536, decisão do dono: sete dias como política inicial).
--
-- O DEFEITO QUE ISSO FECHA
--   A migration 102 já obrigava todo export a ter prazo
--   (`privacy_requests_export_expiry_chk`) e `executePrivacyRequest` já gravava
--   `export_expires_at`. Só que NADA apagava o `.enc`. O prazo existia no
--   banco; o pacote cifrado com o dado consolidado de um titular continuava no
--   disco indefinidamente. É um vazamento com deadline infinito, e pior que o
--   comum: a coluna dá a impressão de que alguém já cuidou disso.
--
-- POR QUE DUAS COLUNAS E NÃO UMA
--   O varredor cruza um arquivo no disco com uma linha no banco, e os dois não
--   commitam juntos. A ordem escolhida é apagar → marcar (ver o cabeçalho de
--   `src/ops/privacy/export-sweeper.ts`), então uma queda no meio deixa o
--   arquivo removido e o pedido ainda candidato — a execução seguinte termina o
--   serviço. Para isso funcionar, "entrou em varredura" e "varredura concluída"
--   precisam ser fatos SEPARADOS:
--
--     `export_purge_started_at` — alguém começou. Não autoriza nada e não
--       remove o pedido da fila; serve para o operador enxergar um passe que
--       caiu no meio (`started_at` antigo com `purged_at` nulo) e para o
--       varredor não precisar deduzir isso de um log.
--     `export_purged_at`        — CONCLUÍDO, com o arquivo provado ausente. É a
--       coluna que tira o pedido da fila de candidatos, e é a condição
--       (`IS NULL`) que torna a marcação uma transição de vencedor único: quem
--       não ganha a transição não audita, e é assim que rodar duas vezes produz
--       exatamente uma linha de auditoria.
--
--   Fundi-las numa só faria "começou" e "terminou" indistinguíveis, e um passe
--   interrompido viraria ou um pedido que se declara varrido com o arquivo vivo
--   (se a marcação fosse no começo) ou um passe sem rastro (se fosse no fim).
--
-- POR QUE O LOCATOR NÃO É APAGADO
--   `export_locator` permanece na linha depois da varredura. Ele é o alvo que a
--   remoção auditada nomeia, e zerá-lo tornaria a linha de auditoria
--   irreconciliável com o pedido. Quem LÊ o pedido não recebe mais o locator: a
--   leitura passa por `readExportArtifact`
--   (`src/ops/privacy/export-sweeper.ts`), que devolve estado `purged` e
--   locator nulo — o pedido indica ARTEFATO EXPIRADO em vez de apontar para um
--   arquivo que não existe mais.
--
-- POR QUE UM ÍNDICE PARCIAL
--   A pergunta do varredor é sempre "quais exports vencidos ainda não foram
--   varridos?", e a resposta saudável é um punhado de linhas num universo de
--   pedidos majoritariamente sem artefato. Um índice completo sobre
--   `export_expires_at` pagaria manutenção em toda linha de `privacy_requests`
--   para responder uma pergunta que só alcança as que têm locator vivo. Mesmo
--   padrão de `067_outbound_messages_sweeper_index.sql` e
--   `070_idempotency_effect_outbox_retention_index.sql`: as colunas de
--   igualdade ancoram a sonda e `export_expires_at` sustenta ao mesmo tempo o
--   predicado de faixa (`<= now()`) e o `ORDER BY` que o LIMIT percorre.
--
-- Idempotente (IF NOT EXISTS). Sem BEGIN/COMMIT: o runner (`src/migrations/`)
-- já envolve cada arquivo numa transação.

ALTER TABLE privacy_requests
  ADD COLUMN IF NOT EXISTS export_purge_started_at timestamptz;

ALTER TABLE privacy_requests
  ADD COLUMN IF NOT EXISTS export_purged_at timestamptz;

-- Um pedido não pode se declarar varrido sem ter tido artefato: a coluna é
-- evidência de uma REMOÇÃO, e uma remoção sem alvo não aconteceu.
ALTER TABLE privacy_requests DROP CONSTRAINT IF EXISTS privacy_requests_export_purge_chk;

ALTER TABLE privacy_requests ADD CONSTRAINT privacy_requests_export_purge_chk
  CHECK (export_purged_at IS NULL OR export_locator IS NOT NULL);

-- A fila do varredor, exatamente como ele a consulta.
CREATE INDEX IF NOT EXISTS privacy_requests_export_sweep_idx
  ON privacy_requests (export_expires_at)
  WHERE export_locator IS NOT NULL AND export_purged_at IS NULL;

-- A pergunta do incidente: "algum passe começou e nunca terminou?". A resposta
-- saudável é zero linhas, que é o que um índice parcial responde de graça.
CREATE INDEX IF NOT EXISTS privacy_requests_export_purge_open_idx
  ON privacy_requests (export_purge_started_at)
  WHERE export_purge_started_at IS NOT NULL AND export_purged_at IS NULL;
