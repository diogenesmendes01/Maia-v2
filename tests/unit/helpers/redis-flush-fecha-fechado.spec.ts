/**
 * Issue #571, revisão da PR #597 — a limpeza do Redis não pode falhar em
 * silêncio na rodada de integração.
 *
 * O `catch {}` mudo de `flushRedis` era justificado por "Redis fora do ar é o
 * caso normal de uma rodada só de unit". Só que ele nunca era alcançado numa
 * rodada de unit: `setup()` retorna antes quando não há `TEST_DB_URL`. O que o
 * silêncio cobria de fato era o modo que PEDIU infra real — ACL recusando
 * `FLUSHDB`, índice de db fora do `--databases` do servidor, indisponibilidade
 * transitória — e nesses casos a suíte seguia lendo resíduo da rodada anterior
 * como resultado desta.
 */
import { describe, it, expect } from 'vitest';
import { flushRedis } from '../../globalSetup.js';

describe('#571 — limpeza do Redis falha FECHADO quando a rodada pediu infra real', () => {
  it('um endpoint inalcançável reprova a rodada em vez de seguir', async () => {
    // Porta 1: recusa de conexão imediata, sem depender de haver ou não Redis
    // na máquina de quem roda.
    await expect(flushRedis('redis://127.0.0.1:1/9', 9)).rejects.toThrow(/#571/);
  });

  it('o diagnóstico nomeia o destino e o remédio, e NÃO carrega a senha', async () => {
    const url = 'redis://usuario:sup3r-secreta@127.0.0.1:1/9';
    const erro = await flushRedis(url, 9).catch((e: unknown) => e as Error);

    expect(erro).toBeInstanceOf(Error);
    // Para onde a conexão foi — sem isso o erro não é acionável.
    expect(erro.message).toContain('127.0.0.1:1');
    expect(erro.message).toContain('db 9');
    expect(erro.message).toContain('test:integration:setup');
    // E a credencial não vai para o log do CI.
    expect(erro.message).not.toContain('sup3r-secreta');
    expect(erro.message).toContain('***');
    // A causa original continua disponível para quem depurar.
    expect((erro as Error & { cause?: unknown }).cause).toBeDefined();
  });
});
