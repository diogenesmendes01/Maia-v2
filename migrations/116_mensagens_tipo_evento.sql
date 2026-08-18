-- Issue #577 — `mensagens.tipo` passa a admitir 'evento'.
--
-- POR QUE. `flushUnconfirmedToolSummaries()` (`src/agent/react-loop.ts`) grava a
-- row placeholder que carrega `ferramentas_chamadas` de um turno que terminou
-- SEM outbound (`iteration_cap` / `empty_final_text`). Ela sempre nasceu com
-- `tipo='evento'`, e o CHECK de `migrations/001_initial.sql:169` só admitia
-- ('texto','audio','imagem','documento','sistema'): todo INSERT do flush violava
-- a constraint, o `catch` do helper engolia, e o rastro das ferramentas daquele
-- turno desaparecia do histórico. Helper morto desde que nasceu.
--
-- POR QUE 'evento' E NÃO 'sistema' (que já passava no CHECK). O único consumidor
-- que ramifica pelo valor — `src/agent/prompt-builder.ts` (`isEventOnly`) — já
-- testa `m.tipo === 'evento'`; com 'sistema' aquele ramo continuaria morto e o
-- descarte dependeria só do fallback `conteudo === ''`. E 'sistema' já tem dono:
-- `src/gateway/baileys.ts` carimba nos frames de ENTRADA que o gateway não
-- consegue classificar (ruído de protocolo, sempre `direcao='in'`). Reaproveitar
-- confundiria ruído de gateway com rastro de auditoria no mesmo SELECT.
--
-- NOTE: sem BEGIN/COMMIT — migrate.ts envolve em transação.

ALTER TABLE mensagens DROP CONSTRAINT IF EXISTS mensagens_tipo_check;

ALTER TABLE mensagens ADD CONSTRAINT mensagens_tipo_check
  CHECK (tipo IN ('texto', 'audio', 'imagem', 'documento', 'sistema', 'evento'));
