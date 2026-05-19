/**
 * Smoke test for the agentProfile fixture builder.
 *
 * Validates that buildProfileVersion() returns an object that:
 *   1. Satisfies the Drizzle-inferred AgentOperationalProfileVersion type.
 *   2. Contains all required top-level columns (profile_body, status, etc.)
 *   3. Embeds legacy 4-layer keys inside profile_body for migration-window consumers.
 *   4. Supports deep overrides without breaking shape invariants.
 */
import { describe, it, expect } from 'vitest';
import { buildProfileVersion, legacyCore, legacyOp } from './agentProfile.js';
import { PROFILE_BODY_SCHEMA_VERSION } from '@/db/schema.js';

describe('buildProfileVersion fixture', () => {
  it('returns a valid AgentOperationalProfileVersion with all required columns', () => {
    const v = buildProfileVersion();
    expect(v.id).toBeTruthy();
    expect(v.tenant_id).toBe('default');
    expect(v.agent_id).toBe('default');
    expect(v.version).toBe(1);
    expect(v.status).toBe('active');
    expect(v.profile_body).toBeTruthy();
    expect(v.proposed_by).toBe('system_seed');
    expect(v.created_at).toBeInstanceOf(Date);
  });

  it('profile_body has correct schema_version', () => {
    const v = buildProfileVersion();
    const body = v.profile_body as { schema_version: string };
    expect(body.schema_version).toBe(PROFILE_BODY_SCHEMA_VERSION);
  });

  it('profile_body.identity contains role_descriptor mapped from identity_block', () => {
    const v = buildProfileVersion();
    const body = v.profile_body as {
      identity: { role_descriptor: string; priorities: string[] };
    };
    expect(body.identity.role_descriptor).toContain('Maia');
    expect(Array.isArray(body.identity.priorities)).toBe(true);
    expect(body.identity.priorities.length).toBeGreaterThan(0);
  });

  it('legacy 4-layer keys are embedded inside profile_body for migration-window consumers', () => {
    const v = buildProfileVersion();
    const core = legacyCore(v);
    const op = legacyOp(v);
    expect(core.identity_block).toContain('Maia');
    expect(Array.isArray(core.principles)).toBe(true);
    expect(core.principles.length).toBeGreaterThan(0);
    expect(op.voice_descriptor).toContain('Português');
    expect(typeof op.thresholds).toBe('object');
  });

  it('status override works correctly', () => {
    const v = buildProfileVersion({ status: 'proposed' });
    expect(v.status).toBe('proposed');
  });

  it('_legacy override changes embedded legacy keys', () => {
    const v = buildProfileVersion({
      _legacy: {
        core_immutable: {
          identity_block: 'CUSTOM_IDENTITY',
          principles: ['princípio X'],
        },
      },
    });
    const core = legacyCore(v);
    expect(core.identity_block).toBe('CUSTOM_IDENTITY');
    expect(core.principles).toEqual(['princípio X']);
  });

  it('profile_body override merges into the body', () => {
    const v = buildProfileVersion({
      profile_body: {
        style: { language: 'en-US', rhythm: {} },
      },
    });
    const body = v.profile_body as { style: { language: string } };
    expect(body.style.language).toBe('en-US');
  });
});
