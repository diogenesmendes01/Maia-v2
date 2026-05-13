DELETE FROM channel_policies WHERE tenant_id='default' AND agent_id='default';
DELETE FROM channels WHERE tenant_id='default' AND agent_id='default' AND external_id='default-channel';
DELETE FROM roles WHERE tenant_id='default' AND agent_id='default' AND role_key='default';
