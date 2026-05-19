/**
 * P8a Task 14 — Context Packet feature flag tests.
 *
 * Tests the precedence order:
 *   kill_switch > tenant_override > global env > default(OFF).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  isContextPacketV1Enabled,
  type ContextPacketFlagSource,
} from '@/runtime/feature-flags/context-packet-flag.js';

const mkEnvSource = (vars: Record<string, string>): ContextPacketFlagSource => ({
  getEnv(name) {
    return vars[name];
  },
  async getTenantOverride() {
    return null;
  },
});

describe('isContextPacketV1Enabled', () => {
  beforeEach(() => {
    delete process.env.FEATURE_CONTEXT_PACKET_V1;
    delete process.env.FEATURE_CONTEXT_PACKET_V1_KILL_SWITCH;
  });

  it('default is OFF (no env, no override)', async () => {
    const result = await isContextPacketV1Enabled('tenant1', mkEnvSource({}));
    expect(result).toBe(false);
  });

  it('global env FEATURE_CONTEXT_PACKET_V1=true → ON', async () => {
    const result = await isContextPacketV1Enabled(
      'tenant1',
      mkEnvSource({ FEATURE_CONTEXT_PACKET_V1: 'true' }),
    );
    expect(result).toBe(true);
  });

  it('kill switch overrides everything else', async () => {
    const result = await isContextPacketV1Enabled(
      'tenant1',
      mkEnvSource({
        FEATURE_CONTEXT_PACKET_V1: 'true',
        FEATURE_CONTEXT_PACKET_V1_KILL_SWITCH: 'true',
      }),
    );
    expect(result).toBe(false);
  });

  it('tenant override=true beats global=false', async () => {
    const source: ContextPacketFlagSource = {
      getEnv(name) {
        if (name === 'FEATURE_CONTEXT_PACKET_V1') return 'false';
        return undefined;
      },
      async getTenantOverride(_t) {
        return true;
      },
    };
    const result = await isContextPacketV1Enabled('tenant1', source);
    expect(result).toBe(true);
  });

  it('tenant override=false beats global=true', async () => {
    const source: ContextPacketFlagSource = {
      getEnv(name) {
        if (name === 'FEATURE_CONTEXT_PACKET_V1') return 'true';
        return undefined;
      },
      async getTenantOverride(_t) {
        return false;
      },
    };
    const result = await isContextPacketV1Enabled('tenant1', source);
    expect(result).toBe(false);
  });

  it('kill switch overrides tenant override', async () => {
    const source: ContextPacketFlagSource = {
      getEnv(name) {
        if (name === 'FEATURE_CONTEXT_PACKET_V1_KILL_SWITCH') return 'true';
        return undefined;
      },
      async getTenantOverride() {
        return true;
      },
    };
    const result = await isContextPacketV1Enabled('tenant1', source);
    expect(result).toBe(false);
  });

  it('tenant override source error → falls back to global env', async () => {
    const source: ContextPacketFlagSource = {
      getEnv(name) {
        if (name === 'FEATURE_CONTEXT_PACKET_V1') return 'true';
        return undefined;
      },
      async getTenantOverride() {
        throw new Error('override source down');
      },
    };
    const result = await isContextPacketV1Enabled('tenant1', source);
    expect(result).toBe(true);
  });

  it('uses real process.env when no source is supplied', async () => {
    process.env.FEATURE_CONTEXT_PACKET_V1 = 'true';
    try {
      const result = await isContextPacketV1Enabled('tenant1');
      expect(result).toBe(true);
    } finally {
      delete process.env.FEATURE_CONTEXT_PACKET_V1;
    }
  });
});
