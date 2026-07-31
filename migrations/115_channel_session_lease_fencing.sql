-- 115 — POSSE EXCLUSIVA da sessão de linha, com lease e fencing token
-- (issue #513 §6).
--
-- ── O que a 103 (#518) já tinha, e por que não bastava ────────────────────
--
-- A 103 introduziu `session_owner_instance` + `session_owner_lease_expires_at`
-- para ENDEREÇAR comandos (`stop_line`, `repair`) à réplica que segura o
-- socket. Isso resolve roteamento, não EXCLUSIVIDADE: a escrita é um UPSERT
-- last-writer-wins (`renewSessionLeases`), feito DEPOIS de o socket já estar
-- aberto. O comentário do repo é explícito sobre a premissa —
--
--     "Não usa CAS por dono: exatamente uma réplica pode ter a sessão viva
--      (o CAS de `activateVerified` elege quem sobe)"
--
-- — e a premissa só vale para o caminho de ATIVAÇÃO. O caminho de BOOT não
-- passa por lá: `startAdditionalLineSessions()` enumera todas as linhas ativas
-- e abre um socket para cada uma, sem reivindicar nada. Duas réplicas com
-- `MAIA_PROCESS_ROLE=session-owner` abrem, hoje, a MESMA linha — e a segunda
-- simplesmente sobrescreve o registro de posse da primeira.
--
-- ── O que estas colunas acrescentam ───────────────────────────────────────
--
-- `session_fencing_token`  — contador MONOTÔNICO por canal. Incrementa a cada
--   nova AQUISIÇÃO (nunca em renovação, nunca em release). É o que distingue
--   "ainda sou o dono" de "fui dono, perdi e reassumi": um processo pausado
--   por GC pode voltar com a lease vencida e reassumida por outro; comparar
--   apenas `session_owner_instance` não detecta o caso quando a MESMA
--   instância reassume. O token detecta.
--
-- `session_owner_acquired_at` — quando esta posse (este token) começou. É o
--   dado operacional que o runbook de takeover pede: "há quanto tempo esta
--   réplica segura a linha".
--
-- ── Relógio ───────────────────────────────────────────────────────────────
--
-- A expiração é avaliada com o relógio do BANCO (`now()`), nunca com o do
-- processo (issue #513 §6: "Relógio do banco, não do processo, define
-- expiração"). Containers com clock skew, sem isso, roubam ou cedem a posse
-- indevidamente. As colunas guardam timestamptz; quem calcula é o SQL do
-- repositório (`acquireSessionLease` / `renewSessionLease`).
--
-- Append-only e retrocompatível: DEFAULT 0 preenche as rows existentes, e um
-- deployment que rode o código anterior a esta migration simplesmente ignora
-- as duas colunas (o UPSERT antigo continua válido).

ALTER TABLE channel_line_state
  ADD COLUMN IF NOT EXISTS session_fencing_token bigint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS session_owner_acquired_at timestamptz;

-- Monotonicidade é a propriedade INTEIRA do fencing token: um token que anda
-- para trás revalidaria um dono antigo. O banco recusa o valor negativo; o
-- incremento-only é garantido pelo repositório (só há `+ 1`, nunca um SET
-- literal).
ALTER TABLE channel_line_state
  DROP CONSTRAINT IF EXISTS channel_line_state_session_fence_chk;
ALTER TABLE channel_line_state
  ADD CONSTRAINT channel_line_state_session_fence_chk
  CHECK (session_fencing_token >= 0);

-- Uma posse REGISTRADA sempre carrega lease e início — sem isso a row diria
-- "esta réplica é dona" sem dizer até quando, e o takeover não teria critério.
-- Fail-closed por construção: a ausência dos três campos é "sem dono".
ALTER TABLE channel_line_state
  DROP CONSTRAINT IF EXISTS channel_line_state_session_owner_complete_chk;
ALTER TABLE channel_line_state
  ADD CONSTRAINT channel_line_state_session_owner_complete_chk
  CHECK (
    session_owner_instance IS NULL
    OR (
      session_owner_lease_expires_at IS NOT NULL
      AND session_owner_acquired_at IS NOT NULL
    )
  );

-- Heartbeat/CAS do dono da SESSÃO: renova apenas as suas rows. Espelha o
-- `channel_line_state_owner_idx` da 103, que cobre o dono do COMANDO.
CREATE INDEX IF NOT EXISTS channel_line_state_session_owner_idx
  ON channel_line_state (session_owner_instance)
  WHERE session_owner_instance IS NOT NULL;

-- Varredura de takeover: quem procura linhas órfãs busca por lease VENCIDA,
-- não por identidade de dono (mesmo racional de `failStalePairings`).
CREATE INDEX IF NOT EXISTS channel_line_state_session_lease_expiry_idx
  ON channel_line_state (session_owner_lease_expires_at)
  WHERE session_owner_instance IS NOT NULL;

-- Backfill do início da posse para as rows que a 103 já deixou com dono
-- registrado: sem isto o CHECK acima recusaria a migration num banco com
-- réplicas vivas no momento do deploy. `last_transition_at` é a melhor
-- aproximação disponível e só alimenta diagnóstico, nunca decisão de posse
-- (quem decide é a lease).
UPDATE channel_line_state
   SET session_owner_acquired_at = COALESCE(session_owner_acquired_at, last_transition_at)
 WHERE session_owner_instance IS NOT NULL
   AND session_owner_acquired_at IS NULL;
