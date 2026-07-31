-- 119 down — remove a versão do payload assinado (issue #535).
--
-- ATENÇÃO ao reverter com envelopes v2 já gravados. Sem esta coluna, o
-- verificador do build revertido recomputa TODA linha pelo payload v1, e os
-- envelopes assinados em v2 passam a sair como `invalid` — não porque foram
-- adulterados, mas porque o leitor perdeu a informação de quais campos foram
-- assinados. Ou seja: rodar este down NÃO é um no-op de leitura.
--
-- Ordem de reversão segura, quando houver linhas v2:
--   1. Reverter primeiro a APLICAÇÃO para o build que assina/verifica só v1.
--      Ele volta a gravar v1 e a coluna deixa de receber 2 em linhas novas.
--   2. Só derrubar a coluna se as linhas v2 já estiverem fora da janela de
--      retenção de auditoria, ou se a perda de verificabilidade delas for
--      aceita explicitamente pelo owner e registrada.
--
-- A alternativa — reassinar as linhas v2 em v1 antes de derrubar a coluna — é
-- pior e não está aqui de propósito: reassinar evidência com a chave de hoje
-- apaga a prova de que ela não mudou desde que foi escrita, que é a única coisa
-- que a assinatura serve para afirmar.
--
-- Constraint antes da coluna: derrubar a coluna levaria a constraint junto, mas
-- a ordem explícita mantém o down legível e um erro parcial diagnosticável.

ALTER TABLE runtime_trace_envelopes
  DROP CONSTRAINT IF EXISTS runtime_trace_env_payload_version_chk;

ALTER TABLE runtime_trace_envelopes
  DROP COLUMN IF EXISTS envelope_payload_version;
