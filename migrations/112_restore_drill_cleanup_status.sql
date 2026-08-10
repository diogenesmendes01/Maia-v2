-- 112 — `restore_drills.cleanup_status`: o drill passa a registrar se o HOST
-- ficou limpo, num eixo próprio (issue #536, achado de revisão da PR #541).
--
-- O DEFEITO QUE ISSO FECHA
--   `src/ops/backup/drill.ts` derruba o banco efêmero e apaga os arquivos
--   estagiados num `finally` (a #536 já corrigiu o vazamento do caminho feliz).
--   Só que o teardown apenas LOGAVA a falha: `failure` continuava null e o
--   status calculado logo abaixo CERTIFICAVA o drill. Havia até teste fixando
--   isso como esperado — um `DROP DATABASE` recusado terminava `passed`
--   enquanto uma cópia completa da produção, em claro, permanecia no host num
--   banco que ninguém rastreia. Um drill verde que vaza produção é pior que um
--   drill vermelho: ele treina o operador a confiar num sinal nocivo.
--
-- POR QUE UMA COLUNA NOVA, E NÃO SÓ UM `failure_code`
--   Falha de probe e falha de teardown são DIAGNÓSTICOS DIFERENTES e podem
--   ocorrer juntas. Com um único `failure_code`, a primeira mascara a segunda:
--   o drill registraria `probe_failed` e o resíduo — a cópia da produção —
--   sumiria da evidência. Com dois eixos:
--     * `failure_code`   = o veredito da fase de RESTORE (ou `cleanup_failed`,
--                          quando o restore provou e só o teardown falhou);
--     * `cleanup_status` = o estado do HOST, sempre presente, independente.
--   "Quais drills deixaram cópia de produção para trás?" vira um predicado
--   indexado, e não uma caçada dentro do jsonb `probes`.
--
-- O VOCABULÁRIO
--   'clean'   — provado: banco efêmero e arquivos estagiados (inclusive o
--               plaintext decifrado) não existem mais. Checado DEPOIS da
--               remoção, não deduzido de uma chamada que não lançou.
--   'unsafe'  — algo ainda está lá, ou a ausência não pôde ser provada. Os dois
--               casos são o mesmo para o operador: alguém precisa ir olhar.
--   'unknown' — DEFAULT, e o único valor que o código nunca escreve: é o estado
--               de uma linha cujo processo morreu entre `createDrill` e
--               `finishDrill`. Significa "resíduo possível, ninguém conferiu" —
--               é o valor honesto para um drill que foi SIGKILLado, e por isso
--               ele NÃO pode ser 'clean'.
--   O detalhe (quais recursos, e por quê) fica em `probes->'cleanup'`, que
--   guarda só CÓDIGOS e booleanos: nunca caminho, nome de banco ou chave.
--
-- Backfill: as linhas antigas ficam em 'unknown', que é a verdade sobre elas —
-- foram gravadas por um código que não conferia o teardown. Marcá-las 'clean'
-- seria inventar evidência retroativa exatamente do tipo que este achado pune.
--
-- Idempotente (IF NOT EXISTS). Sem BEGIN/COMMIT: o runner (`src/migrations/`)
-- já envolve cada arquivo numa transação.

ALTER TABLE restore_drills
  ADD COLUMN IF NOT EXISTS cleanup_status text NOT NULL DEFAULT 'unknown';

ALTER TABLE restore_drills DROP CONSTRAINT IF EXISTS restore_drills_cleanup_status_chk;

ALTER TABLE restore_drills ADD CONSTRAINT restore_drills_cleanup_status_chk
  CHECK (cleanup_status IN ('unknown', 'clean', 'unsafe'));

-- Índice PARCIAL: o que se consulta em incidente é "há resíduo?", e a resposta
-- saudável é zero linhas. Um índice completo sobre uma coluna com 99% de
-- 'clean' não serviria a essa pergunta.
CREATE INDEX IF NOT EXISTS restore_drills_unsafe_idx
  ON restore_drills (started_at DESC)
  WHERE cleanup_status = 'unsafe';
