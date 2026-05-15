-- P6: seed para preservar comportamento da Maia atual no schema multi-channel
-- Cria: default channel, default role (is_default=true), default policy (free_with_trigger).
-- Idempotente via ON CONFLICT DO NOTHING.
-- NOTE: no BEGIN/COMMIT — migrate.ts wraps in transaction.

DO $$
DECLARE
  default_role_uuid UUID;
  default_channel_uuid UUID;
BEGIN
  -- Default role
  INSERT INTO roles (tenant_id, agent_id, role_key, display_name, description, is_default, active)
  VALUES ('default', 'default', 'default', 'Default', 'Modo operacional padrão (compatibilidade legacy)', true, true)
  ON CONFLICT (tenant_id, agent_id, role_key) DO NOTHING
  RETURNING id INTO default_role_uuid;

  IF default_role_uuid IS NULL THEN
    SELECT id INTO default_role_uuid FROM roles WHERE tenant_id='default' AND agent_id='default' AND role_key='default';
  END IF;

  -- Default channel
  INSERT INTO channels (tenant_id, agent_id, external_id, channel_type, display_name, active)
  VALUES ('default', 'default', 'default-channel', 'whatsapp', 'Default WhatsApp Channel', true)
  ON CONFLICT (tenant_id, channel_type, external_id) DO NOTHING
  RETURNING id INTO default_channel_uuid;

  IF default_channel_uuid IS NULL THEN
    SELECT id INTO default_channel_uuid FROM channels
    WHERE tenant_id='default' AND channel_type='whatsapp' AND external_id='default-channel';
  END IF;

  -- Default channel policy (free_with_trigger preserves legacy "no role switching")
  INSERT INTO channel_policies (
    tenant_id, agent_id, channel_id, default_role_id,
    switch_behavior, announce_mode
  )
  VALUES (
    'default', 'default', default_channel_uuid, default_role_uuid,
    'free_with_trigger', 'affects_user'
  )
  ON CONFLICT (channel_id) DO NOTHING;
END $$;
