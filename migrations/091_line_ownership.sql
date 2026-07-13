-- 091 — Ownership de linha WhatsApp (spec roteamento Draft v4 §2).
--
-- 1. Unicidade GLOBAL de linha ativa, RESTRITA a whatsapp (review v4 — web/
--    api/other podem legitimamente repetir external_id entre tenants). O
--    conflito passa a acontecer na ATIVAÇÃO (pareamento) como 23505 — nunca
--    como drop de tráfego em runtime.
--    FAIL-CLOSED: a criação do índice FALHA se houver duplicata ativa
--    whatsapp — o runbook docs/runbooks/line-ownership-duplicates.md decide
--    qual lado desativar ANTES de aplicar; a migração não escolhe sozinha.
--
-- 2. Normalização E.164 canônica COM '+' (review v4 — o resolver usa '+';
--    canais sem '+' quebrariam o exact lookup). Apenas para whatsapp com
--    external_id numérico; valores não-normalizáveis são deixados intactos e
--    REPORTADOS (query de auditoria no runbook) — o pareamento os corrige.

-- (2) primeiro: normaliza dígitos-puros para +digitos, exceto o canal
-- catch-all semeado ('default-channel', não-numérico — intacto).
UPDATE channels
   SET external_id = '+' || external_id
 WHERE channel_type = 'whatsapp'
   AND external_id ~ '^[1-9][0-9]{6,14}$';

-- (1) unicidade global parcial (whatsapp ativo).
CREATE UNIQUE INDEX channels_active_line_uq
  ON channels (channel_type, external_id)
  WHERE active AND channel_type = 'whatsapp';
