-- 114 — credencial de BOOTSTRAP GLOBAL de uso único (issue #519 §9).
--
-- O que isto substitui: `docs/admin-ui-deploy.md` mandava o operador abrir o
-- `psql` e dar um `INSERT INTO app_users (...)` à mão para criar o primeiro
-- administrador. Um INSERT manual não tem precondição, não tem expiração, não
-- tem trilha e não tem como ser revogado — e quem tem acesso ao psql para
-- executá-lo tem acesso para se dar `founder` em qualquer tenant, para sempre.
--
-- O contrato aqui:
--   - o segredo é gerado FORA do banco (`npm run bootstrap:credential`) com
--     entropia alta e mostrado UMA vez no terminal;
--   - só o SHA-256 é persistido — o banco nunca vê o segredo em claro, então
--     um dump não o contém;
--   - o segredo viaja no CORPO de um POST autenticado por ele mesmo, nunca em
--     query string (invariante da issue: segredo não entra em URL, log,
--     tracing ou auditoria);
--   - o consumo é um CAS (`consumed_at IS NULL`): duas requisições simultâneas
--     produzem no máximo um bootstrap;
--   - tentativa errada incrementa `attempts` e, no limite, trava por
--     `locked_until` — sem lockout, o hash vira um oráculo de força bruta;
--   - existe no máximo UMA credencial viva por vez (índice parcial abaixo):
--     emitir uma nova exige revogar a anterior, explicitamente.
CREATE TABLE IF NOT EXISTS bootstrap_credentials (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- SHA-256 hex do segredo. UNIQUE para que reemitir o MESMO segredo por
  -- acidente falhe em vez de criar uma segunda credencial válida.
  secret_hash text NOT NULL UNIQUE,
  -- Rótulo operacional livre e NÃO-secreto ("deploy inicial staging").
  label text,

  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,

  consumed_at timestamptz,
  consumed_by_run_id uuid REFERENCES onboarding_runs(id) ON DELETE RESTRICT,

  revoked_at timestamptz,
  -- Motivo SANITIZADO da revogação (texto do operador, nunca segredo).
  revoked_reason text,

  -- Rate limit / lockout persistidos: o processo pode reiniciar entre
  -- tentativas, então um contador em memória não protege nada.
  attempts integer NOT NULL DEFAULT 0,
  last_attempt_at timestamptz,
  locked_until timestamptz,

  CONSTRAINT bootstrap_credentials_consumed_chk CHECK (
    consumed_at IS NULL OR consumed_by_run_id IS NOT NULL
  )
);

-- No máximo UMA credencial viva (não consumida e não revogada). A expressão
-- indexada é constante dentro do predicado parcial — é o truque padrão de
-- "singleton row" e é o que impede duas credenciais válidas coexistirem.
CREATE UNIQUE INDEX IF NOT EXISTS bootstrap_credentials_single_live_uq
  ON bootstrap_credentials ((consumed_at IS NULL AND revoked_at IS NULL))
  WHERE consumed_at IS NULL AND revoked_at IS NULL;

CREATE INDEX IF NOT EXISTS bootstrap_credentials_expiry_idx
  ON bootstrap_credentials (expires_at)
  WHERE consumed_at IS NULL AND revoked_at IS NULL;
