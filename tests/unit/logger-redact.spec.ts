import { describe, it, expect } from 'vitest';
import pino from 'pino';
import { Writable } from 'node:stream';

// We can't easily intercept the singleton `logger` (it has its own transport),
// so we re-create a pino instance with the same redact paths and pipe it to
// an in-memory stream. This validates the redact config itself, which is what
// the issue is about.
const REDACT_PATHS = [
  '*.ANTHROPIC_API_KEY',
  '*.OPENAI_API_KEY',
  '*.VOYAGE_API_KEY',
  '*.TELEGRAM_BOT_TOKEN',
  '*.SMTP_PASS',
  '*.POSTGRES_PASSWORD',
  '*.password',
  '*.token',
  '*.api_key',
  '*.apiKey',
  'authorization',
  'cookie',
  'config.ANTHROPIC_API_KEY',
  'config.OPENAI_API_KEY',
  'config.VOYAGE_API_KEY',
  'config.SMTP_PASS',
  'config.TELEGRAM_BOT_TOKEN',
  'config.POSTGRES_PASSWORD',
  'pessoa.telefone_whatsapp',
  'telefone_whatsapp',
  '*.conteudo',
  'conteudo',
  '*.valor',
  'valor',
  '*.valor_aprox',
  'valor_aprox',
  '*.cpf',
  'cpf',
  '*.cnpj',
  'cnpj',
  'pessoa.nome',
  'pessoa.apelido',
  'mensagem.conteudo',
  'transacao.valor',
  'transacao.descricao',
  'metadata.payload',
  'metadata.args',
];

function makeCapturingLogger() {
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk, _enc, cb) {
      lines.push(chunk.toString());
      cb();
    },
  });
  const log = pino(
    {
      level: 'debug',
      base: null,
      timestamp: false,
      redact: { paths: REDACT_PATHS, censor: '[REDACTED]' },
    },
    stream,
  );
  return { log, lines };
}

function lastJson(lines: string[]): Record<string, unknown> {
  expect(lines.length).toBeGreaterThan(0);
  return JSON.parse(lines[lines.length - 1]) as Record<string, unknown>;
}

describe('logger — PII redaction', () => {
  it('redacts top-level `conteudo`', () => {
    const { log, lines } = makeCapturingLogger();
    log.info({ conteudo: 'segredo' }, 'msg.received');
    const out = lastJson(lines);
    expect(out.conteudo).toBe('[REDACTED]');
    expect(out.conteudo).not.toBe('segredo');
  });

  it('redacts top-level `valor`', () => {
    const { log, lines } = makeCapturingLogger();
    log.info({ valor: 100 }, 'tx.recorded');
    const out = lastJson(lines);
    expect(out.valor).toBe('[REDACTED]');
    expect(out.valor).not.toBe(100);
  });

  it('redacts pessoa.nome but keeps pessoa.id', () => {
    const { log, lines } = makeCapturingLogger();
    log.info(
      { pessoa: { id: '11111111-1111-1111-1111-111111111111', nome: 'Diogenes' } },
      'pessoa.touched',
    );
    const out = lastJson(lines);
    const pessoa = out.pessoa as Record<string, unknown>;
    expect(pessoa.id).toBe('11111111-1111-1111-1111-111111111111');
    expect(pessoa.nome).toBe('[REDACTED]');
  });

  it('redacts nested `*.conteudo` (e.g. mensagem.conteudo)', () => {
    const { log, lines } = makeCapturingLogger();
    log.info({ mensagem: { id: 'm1', conteudo: 'olá' } }, 'msg.parsed');
    const out = lastJson(lines);
    const mensagem = out.mensagem as Record<string, unknown>;
    expect(mensagem.id).toBe('m1');
    expect(mensagem.conteudo).toBe('[REDACTED]');
  });

  it('redacts cpf, cnpj, valor_aprox', () => {
    const { log, lines } = makeCapturingLogger();
    log.info(
      {
        pessoa: { id: 'p1', cpf: '000.000.000-00', cnpj: '00.000.000/0000-00' },
        valor_aprox: 42,
      },
      'pii.fields',
    );
    const out = lastJson(lines);
    const pessoa = out.pessoa as Record<string, unknown>;
    expect(pessoa.id).toBe('p1');
    expect(pessoa.cpf).toBe('[REDACTED]');
    expect(pessoa.cnpj).toBe('[REDACTED]');
    expect(out.valor_aprox).toBe('[REDACTED]');
  });
});
