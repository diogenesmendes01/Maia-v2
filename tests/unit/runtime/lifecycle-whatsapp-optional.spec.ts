/**
 * WhatsApp opcional para readiness — issue #XXX, OPT-IN.
 *
 * DEFAULT (sem flags): o papel `all` REQUER `whatsapp_session` (comportamento
 * da main). A instância só fica pronta quando a sessão abre pela primeira vez.
 * 
 * OPT-IN: com `READINESS_REQUIRE_WHATSAPP=false`, o papel `all` POSSUI o
 * componente `whatsapp_session` mas não REQUER para readiness. A instância
 * fica pronta quando db+redis estão ok, INDEPENDENTE do WhatsApp. O componente
 * continua sendo reportado em /health e /readyz, mas seu estado não bloqueia
 * a prontidão.
 * 
 * PRECEDÊNCIA: `READINESS_REQUIRE_WHATSAPP_LIVE=true` SEMPRE força WhatsApp
 * obrigatório, mesmo que `READINESS_REQUIRE_WHATSAPP=false`.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const configMock = vi.hoisted(() => ({ 
  READINESS_REQUIRE_WHATSAPP: true,
  READINESS_REQUIRE_WHATSAPP_LIVE: false,
}));
const loggerMock = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}));

vi.mock('../../../src/config/env.js', () => ({ config: configMock }));
vi.mock('../../../src/lib/logger.js', () => ({ logger: loggerMock }));

// Import AFTER the mock is in place.
import { getRoleContract, roleOwns, roleRequires } from '../../../src/runtime/lifecycle/roles.js';

describe('WhatsApp opcional para readiness (READINESS_REQUIRE_WHATSAPP, opt-in)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset para o default entre testes.
    configMock.READINESS_REQUIRE_WHATSAPP = true;
    configMock.READINESS_REQUIRE_WHATSAPP_LIVE = false;
    // Força reimport do módulo para resetar o flag de warning emitido.
    vi.resetModules();
  });

  it('role=all POSSUI whatsapp_session independente da flag', () => {
    configMock.READINESS_REQUIRE_WHATSAPP = true;
    expect(roleOwns('all', 'whatsapp_session')).toBe(true);

    configMock.READINESS_REQUIRE_WHATSAPP = false;
    expect(roleOwns('all', 'whatsapp_session')).toBe(true);
  });

  it('role=all REQUER whatsapp_session por default (READINESS_REQUIRE_WHATSAPP=true)', () => {
    configMock.READINESS_REQUIRE_WHATSAPP = true;
    const contract = getRoleContract('all');
    
    expect(contract.owns).toContain('whatsapp_session');
    expect(contract.requires).toContain('whatsapp_session');
    expect(roleRequires('all', 'whatsapp_session')).toBe(true);
  });

  it('role=all NÃO REQUER whatsapp_session quando READINESS_REQUIRE_WHATSAPP=false (opt-in)', () => {
    configMock.READINESS_REQUIRE_WHATSAPP = false;
    const contract = getRoleContract('all');
    
    expect(contract.owns).toContain('whatsapp_session');
    expect(contract.requires).not.toContain('whatsapp_session');
    expect(roleRequires('all', 'whatsapp_session')).toBe(false);
  });

  it('PRECEDÊNCIA: READINESS_REQUIRE_WHATSAPP_LIVE=true SEMPRE vence', () => {
    configMock.READINESS_REQUIRE_WHATSAPP = false; // tentando relaxar
    configMock.READINESS_REQUIRE_WHATSAPP_LIVE = true; // mas modo estrito vence
    
    const contract = getRoleContract('all');
    
    // Mesmo com REQUIRE_WHATSAPP=false, _LIVE=true força WhatsApp obrigatório.
    expect(contract.owns).toContain('whatsapp_session');
    expect(contract.requires).toContain('whatsapp_session');
    expect(roleRequires('all', 'whatsapp_session')).toBe(true);
  });

  it('PRECEDÊNCIA: warning é emitido quando há conflito entre as flags', async () => {
    configMock.READINESS_REQUIRE_WHATSAPP = false;
    configMock.READINESS_REQUIRE_WHATSAPP_LIVE = true;
    
    // Força reimport para que o warning seja emitido.
    vi.resetModules();
    const { getRoleContract: freshGetRoleContract } = await import('../../../src/runtime/lifecycle/roles.js');
    
    freshGetRoleContract('all');
    
    // Verifica que o warning foi emitido.
    expect(loggerMock.warn).toHaveBeenCalledWith(
      {
        READINESS_REQUIRE_WHATSAPP: false,
        READINESS_REQUIRE_WHATSAPP_LIVE: true,
      },
      expect.stringMatching(/whatsapp_precedence_conflict.*READINESS_REQUIRE_WHATSAPP_LIVE vence/i)
    );
    
    // Warning só é emitido uma vez.
    loggerMock.warn.mockClear();
    freshGetRoleContract('all');
    expect(loggerMock.warn).not.toHaveBeenCalled();
  });

  it('outros papéis não são afetados pela flag (api nunca requer, session-owner sempre requer)', () => {
    configMock.READINESS_REQUIRE_WHATSAPP = true;
    expect(roleRequires('api', 'whatsapp_session')).toBe(false);
    expect(roleRequires('session-owner', 'whatsapp_session')).toBe(true);

    configMock.READINESS_REQUIRE_WHATSAPP = false;
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
