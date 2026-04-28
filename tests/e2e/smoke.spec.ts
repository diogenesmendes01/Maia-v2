/**
 * Smoke E2E — boots the app with mocked Baileys and exercises golden paths.
 * Skipped by default; flip when integration env exists.
 */
import { describe, it } from 'vitest';

describe.skip('smoke e2e (requires Postgres + Redis)', () => {
  it('register R$ 50 mercado returns confirmation', () => {
    // 1) seed owner + entidade + conta
    // 2) inject inbound message
    // 3) assert outbound contains "Lançado"
  });

  it('register R$ 25k triggers dual approval workflow', () => {
    // ...
  });

  it('quarantined newcomer triggers owner confirmation', () => {
    // ...
  });
});
