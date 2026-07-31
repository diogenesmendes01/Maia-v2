-- 119 — versão explícita do payload assinado do envelope (issue #535,
-- continuação da #514).
--
-- POR QUE ESTA COLUNA EXISTE
--
-- A migration 107 acrescentou `root_trace_id` e `attempt` e os deixou FORA do
-- `envelope_hmac`, com a justificativa registrada lá: incluí-los invalidaria
-- todo envelope já escrito, e a integridade do agrupamento se apoiaria em
-- `turno_id`, que é assinado. A decisão do owner na #535 revisou esse ponto:
-- esses dois campos determinam como uma tentativa é LIDA numa investigação
-- ("tentativa 2 de 3", a lista de irmãs no Trace Explorer), e evidência que um
-- operador lê durante um incidente precisa ser verificável, não apenas estar
-- presente. Um `attempt` adulterado não funde dois turnos, mas desordena as
-- tentativas de um — e desordenar a leitura forense já é o suficiente.
--
-- A restrição que a 107 identificou continua válida: mudar o conjunto de campos
-- assinados invalidaria os envelopes existentes. A saída não é reassinar o
-- passado (reassinar evidência com a chave de hoje destrói justamente a
-- propriedade que a assinatura carrega); é VERSIONAR o payload e verificar cada
-- linha pela definição sob a qual ela foi assinada.
--
--   envelope_payload_version = 1 → o payload da #514.
--   envelope_payload_version = 2 → o mesmo, mais `root_trace_id` e `attempt`.
--
-- Ortogonal a `hmac_key_version`. Aquela coluna diz QUAL CHAVE assinou; esta
-- diz QUAIS CAMPOS foram assinados. Uma rotação de chave não muda o payload e
-- uma mudança de payload não rotaciona a chave — misturar os dois eixos numa
-- coluna só tornaria impossível rotacionar sem reinterpretar o conjunto de
-- campos.
--
-- DEFAULT 1, e é isso que preserva a validade do que já existe:
--
--   * As linhas já gravadas foram de fato assinadas com o payload v1. O default
--     não é uma suposição conveniente — é o fato.
--   * Durante o rolling deploy, uma réplica ainda não atualizada segue gravando
--     sem citar a coluna e recebe 1, que também é o fato para ela. Sem isso, o
--     envelope dessa réplica seria lido como v2, a recomputação falharia, e uma
--     janela de deploy viraria uma enxurrada de `invalid` — transformar
--     ciclo de vida em incidente é exatamente o erro que a #514 evitou ao
--     reservar `unknown` para lacuna de chave.
--
-- A versão também entra DENTRO do payload v2 (ver `envelopeSignedPayload()` em
-- `src/control-plane/runtime-trace/envelope-writer.ts`), então ela própria é
-- coberta pela assinatura: baixar a coluna de 2 para 1, para que o verificador
-- ignore `root_trace_id`/`attempt`, não é um downgrade silencioso — apenas faz
-- a recomputação falhar, e a linha sai como `invalid`.
--
-- Aditiva: nenhuma coluna removida, nenhuma constraint apertada, nenhum dado
-- reescrito. Não há backfill porque não há nada a corrigir — o DEFAULT já
-- descreve corretamente cada linha preexistente.
--
-- `ADD COLUMN ... NOT NULL DEFAULT <constante>` não reescreve a tabela no
-- PostgreSQL 11+ (o default fica no catálogo), então isto é seguro sobre uma
-- tabela de evidência grande.

ALTER TABLE runtime_trace_envelopes
  ADD COLUMN IF NOT EXISTS envelope_payload_version INTEGER NOT NULL DEFAULT 1;

-- Versão abaixo de 1 não existe; o writer só grava versões conhecidas, isto
-- fecha a porta para o resto.
ALTER TABLE runtime_trace_envelopes
  DROP CONSTRAINT IF EXISTS runtime_trace_env_payload_version_chk;
ALTER TABLE runtime_trace_envelopes
  ADD CONSTRAINT runtime_trace_env_payload_version_chk
  CHECK (envelope_payload_version >= 1);

COMMENT ON COLUMN runtime_trace_envelopes.envelope_payload_version IS
  'Issue #535: qual conjunto de campos o envelope_hmac cobre. 1 = payload da #514; 2 = + root_trace_id/attempt. Ortogonal a hmac_key_version (qual chave assinou).';
