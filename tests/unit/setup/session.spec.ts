/**
 * Issue #518 — sessão de operador do `/setup`.
 *
 * O contrato que substitui o `?token=`:
 *   - o id de sessão é opaco e não derivável do token;
 *   - expira (TTL) e um id expirado não autentica;
 *   - id malformado/vazio nunca passa (fail-closed);
 *   - rotacionar o token REVOGA as sessões abertas — sem isso, uma aba já
 *     autenticada sobreviveria ao recovery e a rotação seria decorativa.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  createSetupSession,
  verifySetupSession,
  revokeAllSetupSessions,
  SETUP_SESSION_TTL_MS,
  SETUP_SESSION_COOKIE,
  SETUP_TOKEN_HEADER,
  _internal,
} from '../../../src/setup/session.js';

beforeEach(() => {
  revokeAllSetupSessions();
});

describe('createSetupSession', () => {
  it('gera um id opaco de 64 hex (256 bits)', () => {
    const id = createSetupSession();
    expect(id).toMatch(/^[0-9a-f]{64}$/);
  });

  it('dois ids nunca colidem', () => {
    const ids = new Set(Array.from({ length: 50 }, () => createSetupSession()));
    expect(ids.size).toBe(50);
  });
});

describe('verifySetupSession — fail-closed', () => {
  it('aceita um id recém-criado', () => {
    expect(verifySetupSession(createSetupSession())).toBe(true);
  });

  it('rejeita undefined, vazio e comprimento errado', () => {
    createSetupSession();
    expect(verifySetupSession(undefined)).toBe(false);
    expect(verifySetupSession('')).toBe(false);
    expect(verifySetupSession('a'.repeat(63))).toBe(false);
    expect(verifySetupSession('a'.repeat(65))).toBe(false);
  });

  it('rejeita um id desconhecido de comprimento correto', () => {
    createSetupSession();
    expect(verifySetupSession('b'.repeat(64))).toBe(false);
  });

  it('rejeita depois do TTL e limpa a entrada', () => {
    const id = createSetupSession();
    expect(verifySetupSession(id)).toBe(true);
    expect(verifySetupSession(id, Date.now() + SETUP_SESSION_TTL_MS + 1)).toBe(false);
    expect(_internal.size()).toBe(0);
  });

  it('uma sessão expirada não ressuscita', () => {
    const id = createSetupSession();
    _internal.expire(id);
    expect(verifySetupSession(id)).toBe(false);
  });
});

describe('revokeAllSetupSessions', () => {
  it('derruba TODAS as sessões (usado na rotação de token)', () => {
    const a = createSetupSession();
    const b = createSetupSession();
    revokeAllSetupSessions();
    expect(verifySetupSession(a)).toBe(false);
    expect(verifySetupSession(b)).toBe(false);
  });
});

describe('nomes de cookie/header são estáveis', () => {
  it('o cookie e o header do break-glass não mudam sem intenção', () => {
    // Runbooks e a regra do fail2ban dependem destes literais.
    expect(SETUP_SESSION_COOKIE).toBe('maia_setup_session');
    expect(SETUP_TOKEN_HEADER).toBe('x-maia-setup-token');
    expect(SETUP_SESSION_TTL_MS).toBe(30 * 60_000);
  });
});
