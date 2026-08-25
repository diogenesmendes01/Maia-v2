-- 119 — versiona a assinatura do envelope de runtime trace (issue #535).
--
-- Contexto. A migration 107 acrescentou `root_trace_id` e `attempt` e os
-- deixou DE FORA do `envelope_hmac`, com o argumento (registrado no próprio
-- arquivo) de que assiná-los invalidaria todo envelope já escrito. O argumento
-- caducou antes de valer: `FEATURE_RUNTIME_TRACE_V1` nunca foi ligada em
-- produção, então não existe corpus a invalidar — e esta é a última janela
-- barata para consertar o contrato.
--
-- Decisão do owner (#535):
--   * `signature_version=2` assina TAMBÉM `root_trace_id` e `attempt`
--     (e a própria versão — ver abaixo);
--   * produção escreve SÓ v2;
--   * o verifier continua lendo v1, para fixtures e ambientes antigos;
--   * envelopes v1 NÃO são reassinados retroativamente.
--
-- Por que a coluna tem DEFAULT 1 e não 2. Toda linha que existir antes desta
-- migration foi assinada com o conjunto de campos da v1. Um DEFAULT 2 diria ao
-- verifier para recomputar a material v2 sobre uma assinatura v1 e devolveria
-- `invalid` para evidência íntegra — apagar a distinção entre "adulterado" e
-- "assinado por um escritor anterior" é o oposto do que uma trilha de auditoria
-- precisa fazer. O escritor de produção grava o 2 explicitamente
-- (`src/control-plane/runtime-trace/envelope-writer.ts`), então o DEFAULT só
-- descreve o passado.
--
-- Por que isso NÃO abre um downgrade. A versão mora numa coluna, e uma coluna é
-- exatamente o que um atacante com escrita no banco controla. A material da v2
-- inclui `"signature_version":2` — separação de domínio explícita. Virar a
-- coluna de 2 para 1 (a jogada do downgrade, cujo prêmio seria escapar dos dois
-- campos novos) faz o verifier recomputar a material v1 e comparar com um HMAC
-- tirado sobre a material v2: não bate, e a linha lê `invalid` — que é o
-- veredito correto para uma linha que de fato foi adulterada.
--
-- O que continua sendo risco residual: uma linha genuinamente assinada em v1
-- mantém `root_trace_id`/`attempt` fora da assinatura, então NELAS essas duas
-- colunas seguem editáveis sem detecção. Por isso existem duas defesas
-- adicionais, ambas independentes desta migration:
--   * `RUNTIME_TRACE_ACCEPT_SIGNATURE_V1=false` recusa v1 na LEITURA
--     (veredito `rejected_version`, distinto de `invalid`);
--   * `listAttempts()` exige o `turno_id` ASSINADO além do `root_trace_id`, o
--     que impede fusão visual entre turnos mesmo em linhas v1.
--
-- Aditiva: nenhuma coluna removida, nenhum dado reescrito, nenhuma restrição
-- existente endurecida.
-- NOTE: sem BEGIN/COMMIT — migrate.ts envolve o arquivo numa transação.

ALTER TABLE runtime_trace_envelopes
  ADD COLUMN IF NOT EXISTS signature_version INTEGER NOT NULL DEFAULT 1;

-- Fecha o conjunto: uma versão desconhecida gravada por engano (ou por um
-- escritor futuro que não passou por review) precisa falhar na ESCRITA, não
-- virar um `rejected_version` silencioso na leitura meses depois.
ALTER TABLE runtime_trace_envelopes
  DROP CONSTRAINT IF EXISTS runtime_trace_env_signature_version_chk;
ALTER TABLE runtime_trace_envelopes
  ADD CONSTRAINT runtime_trace_env_signature_version_chk
  CHECK (signature_version IN (1, 2));

-- `listAttempts()` passa a filtrar por (tenant_id, root_trace_id, turno_id).
-- O índice de agrupamento da 107 é (tenant_id, root_trace_id, attempt): o
-- predicado novo caía como filtro pós-scan da faixa. Este índice serve o
-- predicado inteiro e mantém `attempt` como sufixo de ordenação.
CREATE INDEX IF NOT EXISTS runtime_trace_env_attempt_turn_idx
  ON runtime_trace_envelopes (tenant_id, root_trace_id, turno_id, attempt)
  WHERE root_trace_id IS NOT NULL AND turno_id IS NOT NULL;
