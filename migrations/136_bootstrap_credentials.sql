-- issue 519 — bootstrap global: a credencial de primeiro bootstrap como DADO.
--
-- POR QUE NO BANCO, E NAO NUM ARQUIVO. Ja existe `src/setup/token.ts`, que
-- guarda um token de uso unico em `<BAILEYS_AUTH_DIR>/control/setup-token.txt`
-- com mode 0600. Aquele desenho e' correto PARA AQUELE CASO: o operador
-- precisa LER o token, entao ele existe em claro, e o arquivo e' local ao
-- processo que parea a linha.
--
-- O bootstrap global tem tres exigencias que arquivo nao atende:
--   1. `armazenar somente hash` — o segredo e' entregue UMA vez a quem
--      instala e nunca mais pode ser lido, nem por quem tem o disco;
--   2. `invalidacao atomica` e `corridas simultaneas criam no maximo um
--      bootstrap valido` — isso e' compare-and-swap entre REPLICAS, e duas
--      replicas nao compartilham filesystem de forma confiavel;
--   3. `bloqueio definitivo apos o bootstrap` — precisa ser um fato que
--      qualquer replica enxerga, inclusive uma que subiu depois.
--
-- Tabelas NOVAS e VAZIAS: sem CONCURRENTLY, com envelope transacional. Nao
-- estao expostas a armadilha de indice invalido da issue 658.

BEGIN;

CREATE TABLE bootstrap_credentials (
  id                text        PRIMARY KEY,

  -- SO o hash. O segredo de 128 bits e' devolvido uma unica vez, na criacao,
  -- e nunca mais existe em lugar nenhum do sistema. Um dump desta tabela nao
  -- permite bootstrap.
  secret_hash       text        NOT NULL,

  created_at        timestamptz NOT NULL DEFAULT now(),
  created_by        text        NOT NULL,

  -- Expiracao. Relogio do BANCO, nunca `Date.now()` de replica — mesma razao
  -- da janela de debounce da 130.
  expires_at        timestamptz NOT NULL,

  -- Rate limit e lockout. `failed_attempts` conta tentativas com segredo
  -- errado; `locked_until` e' o veto temporal que a aplicacao consulta com
  -- `now()` do banco.
  failed_attempts   integer     NOT NULL DEFAULT 0,
  locked_until      timestamptz,

  -- A invalidacao. `UPDATE ... WHERE consumed_at IS NULL` e' o compare-and-swap:
  -- duas tentativas simultaneas com o segredo CERTO produzem exatamente um
  -- consumo (rowCount 1) e um perdedor (rowCount 0).
  consumed_at       timestamptz,

  CONSTRAINT bootstrap_credentials_expira_depois_de_criada
    CHECK (expires_at > created_at),
  CONSTRAINT bootstrap_credentials_tentativas_nao_negativas
    CHECK (failed_attempts >= 0)
);

-- No maximo UMA credencial viva por vez. Sem isto, dois operadores poderiam
-- emitir duas credenciais e ambas valeriam — dois caminhos simultaneos para a
-- identidade administrativa global, que e' exatamente o que a issue proibe.
-- Parcial (WHERE consumed_at IS NULL) para que o historico de credenciais ja'
-- consumidas continue existindo como evidencia.
CREATE UNIQUE INDEX bootstrap_credentials_unconsumed_uq
  ON bootstrap_credentials ((consumed_at IS NULL))
  WHERE consumed_at IS NULL;

-- O BLOQUEIO DEFINITIVO, como fato do banco.
--
-- Checar "ja existe founder?" na aplicacao nao basta: e' uma leitura que a
-- proxima replica pode fazer antes do commit da outra, e a resposta muda com
-- o tempo (um founder pode ser removido). Este marcador e' monotonico — uma
-- vez escrito, nunca deixa de existir — e a unicidade e' do banco.
CREATE TABLE bootstrap_completions (
  -- Coluna de valor unico: garante NO MAXIMO UMA linha na tabela inteira.
  -- Um segundo bootstrap viola a PK, nao uma condicao de corrida.
  singleton         boolean     PRIMARY KEY DEFAULT true,

  completed_at      timestamptz NOT NULL DEFAULT now(),
  credential_id     text        NOT NULL REFERENCES bootstrap_credentials(id),
  tenant_id         text        NOT NULL,
  founder_user_id   text        NOT NULL,

  CONSTRAINT bootstrap_completions_singleton_verdadeiro
    CHECK (singleton = true),

  -- Fail-closed contra o literal que a issue proibe: um bootstrap que
  -- produzisse `tenant_id = 'default'` seria exatamente o INSERT manual que
  -- esta fatia existe para eliminar.
  CONSTRAINT bootstrap_completions_sem_tenant_default
    CHECK (tenant_id <> 'default' AND length(tenant_id) > 0)
);

COMMIT;
