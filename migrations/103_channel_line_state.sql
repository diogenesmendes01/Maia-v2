-- 103 — Estado operacional das LINHAS whatsapp + fila durável de comandos
-- Admin→runtime (issue #518).
--
-- Por que uma tabela nova em vez de sobrecarregar `channels.active`:
--   `active` é ROTEAMENTO (a linha recebe/envia?). O estado operacional é
--   outra dimensão — declarada, pareando, verificada mas offline, conectada,
--   em recovery, deslogada, falha, desabilitada. Misturar os dois produz uma
--   UI mentirosa (canal ativo mas socket caído) e impede o wizard de separar
--   "posse provada" de "pronta para rotear" (§4 da issue).
--
-- Ponte Admin→runtime: o console (Next.js) e o runtime (Fastify + Baileys)
-- são PROCESSOS distintos que compartilham Postgres. Em vez de abrir uma API
-- interna nova (secret novo, superfície de rede nova), esta tabela é a
-- COMMAND QUEUE durável sancionada pela issue: o console escreve
-- `command` + o ATOR administrativo; o worker `channel_pairing` do runtime
-- reivindica (FOR UPDATE SKIP LOCKED), executa e devolve o estado.
--
-- Material sensível (QR/código de pareamento):
--   NUNCA em claro. `pairing_material` é o envelope AES-256-GCM versionado de
--   `src/gateway/staging-crypto.ts` (mesmo keyring do staging 092), com TTL
--   curto em `pairing_material_expires_at`. É apagado ao concluir, abortar,
--   expirar ou reiniciar. NUNCA vai para audit, log ou URL.
CREATE TABLE IF NOT EXISTS channel_line_state (
  channel_id uuid PRIMARY KEY REFERENCES channels(id) ON DELETE CASCADE,
  -- Escopo replicado (não é FK composta para não travar o DELETE do canal):
  -- toda leitura/escrita do console filtra por (tenant_id, agent_id,
  -- channel_id) — lookup cross-tenant não é autorização.
  tenant_id text NOT NULL,
  agent_id text NOT NULL,

  state text NOT NULL DEFAULT 'declared',

  -- ── fila durável de comandos (Admin → runtime) ──────────────────────────
  command text,
  command_method text,
  -- Idempotency key da requisição do console: um retry com a MESMA chave
  -- devolve a sessão existente; uma chave DIFERENTE com pairing em curso é
  -- rejeitada (`pairing_in_progress`).
  command_id uuid,
  command_requested_at timestamptz,
  command_claimed_at timestamptz,
  -- LEASE de posse do trabalho deste canal (review PR #528, P1).
  --
  -- `command_claimed_at` sozinho não resolve nada num deploy com N réplicas:
  -- `FOR UPDATE SKIP LOCKED` só protege a JANELA da transação, e assim que ela
  -- commita a row volta a ser elegível — duas réplicas executavam o MESMO
  -- `command_id`. Pior: o sweep de pareamentos órfãos considerava stale
  -- qualquer `owner_instance` diferente da instância local, então a réplica B
  -- matava a sessão VIVA da réplica A.
  --
  -- A lease é a única fonte de verdade de "alguém vivo está tocando isto": o
  -- dono a renova por heartbeat a cada tick; um dono morto para de renovar e a
  -- lease vence. Quem varre olha a LEASE, nunca a identidade do dono.
  owner_lease_expires_at timestamptz,
  -- Instância que detém o comando ENDEREÇADO (review PR #528 rodada 2).
  -- `stop_line` e `repair` precisam derrubar um socket que vive na MEMÓRIA de
  -- uma réplica específica. Sem endereçamento, qualquer réplica reivindicava o
  -- comando, chamava `stopLineSession` no seu Map local (no-op), e concluía —
  -- o operador via "desabilitada" e a linha continuava respondendo pela outra
  -- réplica. NULL = qualquer réplica pode executar.
  target_instance text,

  -- ── posse da SESSÃO (socket Baileys), distinta da posse do COMANDO ───────
  -- `owner_instance` diz quem está executando a ordem; estas duas dizem quem
  -- segura o socket da linha. São a tabela de roteamento dos comandos
  -- endereçados, e a lease é o que distingue "réplica viva" de "réplica que
  -- morreu levando o socket junto".
  session_owner_instance text,
  session_owner_lease_expires_at timestamptz,
  -- Ator ADMINISTRATIVO preservado ponta a ponta (invariante 4 do AGENTS.md):
  -- o runtime audita a transição citando quem pediu, não "system".
  actor_id text,
  actor_role text,
  correlation_id text,

  -- ── material efêmero CIFRADO ────────────────────────────────────────────
  pairing_material bytea,
  pairing_material_key_id text,
  pairing_material_kind text,
  pairing_material_expires_at timestamptz,

  -- ── metadata operacional NÃO-secreta ────────────────────────────────────
  pairing_method text,
  pairing_started_at timestamptz,
  pairing_expires_at timestamptz,
  pairing_attempts integer NOT NULL DEFAULT 0,
  -- Instância do runtime que detém a PairingSession em memória (§3 da issue:
  -- "o owner da sessão pode ser localizado").
  owner_instance text,
  -- Código de razão SANITIZADO (nunca mensagem crua de erro, nunca auth state).
  reason_code text,
  verified_at timestamptz,
  connected_at timestamptz,
  disconnected_at timestamptz,
  last_transition_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  -- `aborting` (review PR #528, P1): estado INTERMEDIÁRIO entre o operador
  -- pedir o cancelamento e o runtime confirmar que a PairingSession morreu.
  -- Sem ele, o abort devolvia a linha para `declared` NA HORA e um
  -- `start_pairing` imediato sobrescrevia o comando de abort antes do tick —
  -- a sessão antiga nunca era abortada e ainda podia concluir e ATIVAR a
  -- linha. O oposto do que "cancelar" significa.
  CONSTRAINT channel_line_state_state_chk CHECK (state IN (
    'declared',
    'pairing',
    'aborting',
    'verified_offline',
    'connected',
    'recovering',
    'logged_out',
    'failed',
    'disabled'
  )),
  -- `stop_line` (review PR #528, P1): o console não tem o socket. Desabilitar
  -- uma linha precisa DERRUBAR a sessão viva no runtime — cancelar timers,
  -- encerrar o socket, remover o transporte — e não apenas desativar a row.
  CONSTRAINT channel_line_state_command_chk CHECK (
    command IS NULL OR command IN ('start_pairing', 'abort_pairing', 'repair', 'stop_line')
  ),
  CONSTRAINT channel_line_state_method_chk CHECK (
    command_method IS NULL OR command_method IN ('qr', 'code')
  ),
  CONSTRAINT channel_line_state_pairing_method_chk CHECK (
    pairing_method IS NULL OR pairing_method IN ('qr', 'code')
  ),
  CONSTRAINT channel_line_state_material_kind_chk CHECK (
    pairing_material_kind IS NULL OR pairing_material_kind IN ('qr', 'code')
  ),
  -- Material cifrado só existe COM a key_id que o decifra e COM validade —
  -- um envelope órfão seria indecifrável (rotação) ou eterno.
  CONSTRAINT channel_line_state_material_complete_chk CHECK (
    pairing_material IS NULL
    OR (
      pairing_material_key_id IS NOT NULL
      AND pairing_material_kind IS NOT NULL
      AND pairing_material_expires_at IS NOT NULL
    )
  ),
  -- Um comando pendente sempre carrega quem pediu e quando (auditabilidade).
  CONSTRAINT channel_line_state_command_actor_chk CHECK (
    command IS NULL
    OR (actor_id IS NOT NULL AND actor_role IS NOT NULL AND command_requested_at IS NOT NULL)
  )
);

-- Listagem do console: sempre (tenant, agent) primeiro.
CREATE INDEX IF NOT EXISTS channel_line_state_scope_idx
  ON channel_line_state (tenant_id, agent_id);

-- Varredura do worker: só rows COM comando pendente (partial index — o custo
-- do poll é O(pendentes), não O(linhas)).
CREATE INDEX IF NOT EXISTS channel_line_state_pending_command_idx
  ON channel_line_state (command_requested_at)
  WHERE command IS NOT NULL;

-- Heartbeat da lease: o dono renova só as SUAS rows.
CREATE INDEX IF NOT EXISTS channel_line_state_owner_idx
  ON channel_line_state (owner_instance)
  WHERE owner_instance IS NOT NULL;

-- Sweep de TTL do material efêmero + de pairings interrompidos por restart.
CREATE INDEX IF NOT EXISTS channel_line_state_pairing_expiry_idx
  ON channel_line_state (pairing_expires_at)
  WHERE state = 'pairing';

-- Backfill: todo canal whatsapp existente ganha a sua row de estado. Canal
-- ATIVO já provou posse em algum momento (activateVerified) ⇒ nasce
-- `verified_offline` (o boot promove para `connected` quando o socket abre).
-- Canal inativo é `declared`. Fail-closed: nada nasce `connected`.
INSERT INTO channel_line_state (channel_id, tenant_id, agent_id, state, verified_at)
SELECT c.id,
       c.tenant_id,
       c.agent_id,
       CASE WHEN c.active THEN 'verified_offline' ELSE 'declared' END,
       CASE WHEN c.active THEN c.updated_at ELSE NULL END
  FROM channels c
 WHERE c.channel_type = 'whatsapp'
ON CONFLICT (channel_id) DO NOTHING;
