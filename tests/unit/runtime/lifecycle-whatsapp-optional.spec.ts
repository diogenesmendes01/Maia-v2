/**
 * WhatsApp opcional para readiness — issue #XXX.
 *
 * Com `READINESS_REQUIRE_WHATSAPP=false` (default), o papel `all` POSSUI o
 * componente `whatsapp_session` mas não REQUER para readiness. A instância
 * fica pronta quando db+redis estão ok, INDEPENDENTE do WhatsApp. O componente
 * continua sendo reportado em /health e /readyz, mas seu estado não bloqueia
 * a prontidão.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const configMock = vi.hoisted(() => ({ READINESS_REQUIRE_WHATSAPP: false }));

vi.mock('../../../src/config/env.js', () => ({ config: configMock }));

// Import AFTER the mock is in place.
import { getRoleContract, roleOwns, roleRequires } from '../../../src/runtime/lifecycle/roles.js';

describe('WhatsApp opcional para readiness (READINESS_REQUIRE_WHATSAPP)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset para o default entre testes.
    configMock.READINESS_REQUIRE_WHATSAPP = false;
  });

  it('role=all POSSUI whatsapp_session independente da flag', () => {
    configMock.READINESS_REQUIRE_WHATSAPP = false;
    expect(roleOwns('all', 'whatsapp_session')).toBe(true);

    configMock.READINESS_REQUIRE_WHATSAPP = true;
    expect(roleOwns('all', 'whatsapp_session')).toBe(true);
  });

  it('role=all NÃO REQUER whatsapp_session quando READINESS_REQUIRE_WHATSAPP=false (default)', () => {
    configMock.READINESS_REQUIRE_WHATSAPP = false;
    const contract = getRoleContract('all');
    
    expect(contract.owns).toContain('whatsapp_session');
    expect(contract.requires).not.toContain('whatsapp_session');
    expect(roleRequires('all', 'whatsapp_session')).toBe(false);
  });

  it('role=all REQUER whatsapp_session quando READINESS_REQUIRE_WHATSAPP=true', () => {
    configMock.READINESS_REQUIRE_WHATSAPP = true;
    const contract = getRoleContract('all');
    
    expect(contract.owns).toContain('whatsapp_session');
    expect(contract.requires).toContain('whatsapp_session');
    expect(roleRequires('all', 'whatsapp_session')).toBe(true);
  });

  it('outros papéis não são afetados pela flag (api nunca requer, session-owner sempre requer)', () => {
    configMock.READINESS_REQUIRE_WHATSAPP = false;
    expect(roleRequires('api', 'whatsapp_session')).toBe(false);
    expect(roleRequires('session-owner', 'whatsapp_session')).toBe(true);

    configMock.READINESS_REQUIRE_WHATSAPP = true;
    expect(roleRequires('api', 'whatsapp_session')).toBe(false);
    expect(roleRequires('session-owner', 'whatsapp_session')).toBe(true);
  });

  it('role=all continua requerendo os demais componentes independente da flag', () => {
    configMock.READINESS_REQUIRE_WHATSAPP = false;
    const contract = getRoleContract('all');
    
    expect(contract.requires).toContain('config');
    expect(contract.requires).toContain('db');
    expect(contract.requires).toContain('schema');
    expect(contract.requires).toContain('redis');
    expect(contract.requires).toContain('http');
    expect(contract.requires).toContain('queue');
    expect(contract.requires).toContain('agent_worker');
    expect(contract.requires).toContain('cron_scheduler');
  });
});
