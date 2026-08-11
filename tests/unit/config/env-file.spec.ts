/**
 * Issue #515, PR #522 review round 1 [P2] — the `.env` parser used by
 * `maia config check` MUST agree with the parser the runtime boots with.
 *
 * The runtime loads `.env` via `dotenv/config` (`src/config/env.ts:17`). A
 * hand-rolled parser in `generate.ts` diverged from it: for
 *   ALERT_CHANNELS=log # somente log
 * dotenv yields `log` and the process boots, while the hand-rolled parser
 * yielded `log # somente log` and the CLI reported an unknown alert channel.
 * A validator that disagrees with the boot about what the file SAYS is worse
 * than no validator, so `parseEnvFile` now delegates to `dotenv.parse`.
 *
 * These tests pin that delegation: every case is asserted against
 * `dotenv.parse` directly, so they keep holding if dotenv's semantics change
 * under us — the invariant is PARITY, not any particular parse result.
 */
import { describe, it, expect } from 'vitest';
import dotenv from 'dotenv';
import { parseEnvFile } from '@/config/env-file.js';
import { parseEnvFile as reExported } from '@/config/generate.js';
import { validateConfig } from '@/config/validate.js';
import { buildFixture } from '@/config/generate.js';

/** Cases that broke the hand-rolled parser, plus the usual `.env` corners. */
const CASES: readonly [string, string][] = [
  ['comentário inline sem aspas', 'ALERT_CHANNELS=log # somente log'],
  ['comentário inline com espaço antes', 'LOG_LEVEL=info   # barulhento'],
  ['`#` dentro de aspas duplas não é comentário', 'OWNER_NOME="Fulano # Silva"'],
  ['`#` dentro de aspas simples não é comentário', "OWNER_NOME='Fulano # Silva'"],
  ['`#` colado no valor', 'MAIA_DISPLAY_NAME=va#lue'],
  ['valor vazio', 'SMTP_USER='],
  ['valor só com `#`', 'SMTP_USER=#nada'],
  ['aspas duplas', 'MAIA_DISPLAY_NAME="Maia Assistente"'],
  ['aspas simples', "MAIA_DISPLAY_NAME='Maia Assistente'"],
  ['escape \\n dentro de aspas duplas', 'MAIA_STAGING_KEYRING="linha1\\nlinha2"'],
  ['escape \\n NÃO expande em aspas simples', "MAIA_STAGING_KEYRING='linha1\\nlinha2'"],
  ['valor multi-linha entre aspas', 'MAIA_STAGING_KEYRING="linha1\nlinha2"\nOWNER_NOME=depois'],
  ['export prefix', 'export LOG_LEVEL=debug'],
  ['espaços em volta do `=`', 'LOG_LEVEL = debug'],
  ['espaços à direita são aparados', 'LOG_LEVEL=debug   '],
  ['linha de comentário inteira', '# LOG_LEVEL=debug\nLOG_LEVEL=info'],
  ['linha em branco entre pares', 'A_ONE=1\n\nA_TWO=2'],
  ['CRLF', 'LOG_LEVEL=info\r\nAPP_PORT=3000\r\n'],
  ['sinal de `=` dentro do valor', 'RUNTIME_TRACE_HMAC_PREV_MASTER_SECRETS=1=abc;2=def'],
  ['JSON entre aspas simples', "MAIA_STAGING_KEYRING='{\"k1\":\"AAA=\"}'"],
  ['sem `=` é ignorado', 'ISTO_NAO_E_UM_PAR\nLOG_LEVEL=info'],
];

describe('parseEnvFile — paridade com o dotenv do runtime (#515)', () => {
  it.each(CASES)('%s', (_name, content) => {
    expect(parseEnvFile(content)).toEqual(dotenv.parse(content));
  });

  it('o comentário inline que motivou o achado resolve para o canal correto', () => {
    // Este é o caso concreto do review: o boot aceitava `log`, o CLI recusava
    // `log # somente log` como canal desconhecido.
    const env = parseEnvFile('ALERT_CHANNELS=log # somente log');
    expect(env.ALERT_CHANNELS).toBe('log');

    const result = validateConfig({
      env: { ...buildFixture('production'), ...env },
      profile: 'production',
    });
    expect(result.errors.filter((p) => p.rule === 'alerts/unknown-channel')).toEqual([]);
  });

  it('`@/config/generate.js` re-exporta exatamente a mesma função', () => {
    expect(reExported).toBe(parseEnvFile);
  });

  it('parsear NÃO muta process.env (o validador precisa ser puro)', () => {
    const before = JSON.stringify(process.env);
    parseEnvFile('MAIA_PARSE_SIDE_EFFECT_CANARY=1\nLOG_LEVEL=debug');
    expect(JSON.stringify(process.env)).toBe(before);
    expect(process.env.MAIA_PARSE_SIDE_EFFECT_CANARY).toBeUndefined();
  });

  it('o parser é o mesmo que o runtime usa (dotenv), não uma reimplementação', () => {
    // Guard estrutural: se alguém trocar a delegação por um parser próprio,
    // a divergência volta silenciosamente. Uma amostra aleatória de linhas
    // exercita o contrato inteiro contra a referência.
    const sample = CASES.map(([, content]) => content).join('\n');
    expect(parseEnvFile(sample)).toEqual(dotenv.parse(sample));
  });
});
