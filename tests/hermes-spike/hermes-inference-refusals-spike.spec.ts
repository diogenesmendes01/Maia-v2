/**
 * P06 (§9.1 item 10) — toda recusa do gateway, classificada pelo cliente
 * Hermes PINADO. Pula sem `MAIA_HERMES_WORKER_PYTHON`/`MAIA_HERMES_UPSTREAM`.
 *
 * `x-should-retry: false` só desliga o retry do SDK OpenAI. O Hermes tem o
 * próprio laço de retry (`_run_api_retry_loop`), que decide por
 * `agent/error_classifier.classify_api_error` olhando status e TEXTO do corpo.
 * O que a spec exige — "o cliente não deve confundir recusa de policy com erro
 * temporário retentável" — só vale se esse classificador concordar. Este teste
 * pergunta a ele, código por código.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  INFERENCE_ERROR_STATUS,
  toWireError,
  type InferenceErrorCode,
} from '@/integrations/hermes/inference-gateway.js';

const PYTHON = process.env.MAIA_HERMES_WORKER_PYTHON;
const UPSTREAM = process.env.MAIA_HERMES_UPSTREAM;
const d = PYTHON && UPSTREAM ? describe : describe.skip;

type Verdict = { code: string; status: number; reason: string; retryable: boolean };

function classify(): Verdict[] {
  const dir = mkdtempSync(join(tmpdir(), 'maia-hermes-classify-'));
  try {
    const cases = (Object.keys(INFERENCE_ERROR_STATUS) as InferenceErrorCode[]).map((code) => {
      const e = toWireError(code);
      return {
        status: e.status,
        body: e.body,
        headers: e.status === 503 ? {} : { 'x-should-retry': 'false' },
      };
    });
    const file = join(dir, 'cases.json');
    writeFileSync(file, JSON.stringify(cases));
    const out = spawnSync(
      PYTHON as string,
      [resolve('tests/hermes-spike/python/classify_gateway_errors.py'), file],
      {
        encoding: 'utf8',
        env: {
          SystemRoot: process.env.SystemRoot ?? '',
          PATH: process.env.PATH ?? '',
          TEMP: dir,
          TMP: dir,
          PYTHONPATH: UPSTREAM as string,
          PYTHONUTF8: '1',
          // O import do Hermes toca o home: nunca o perfil pessoal.
          HERMES_HOME: join(dir, 'home'),
        },
      },
    );
    if (out.status !== 0) throw new Error(out.stderr.slice(-800));
    return JSON.parse(out.stdout.trim().split('\n').at(-1) as string) as Verdict[];
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

d('spike — recusas do gateway vistas pelo classificador do Hermes pinado', () => {
  it('política, autoridade e cota são terminais; só a indisponibilidade é retentável', () => {
    const verdicts = classify();
    const por = Object.fromEntries(verdicts.map((v) => [v.code, v]));
    for (const code of [
      'invalid_request',
      'unsupported_parameter',
      'invalid_inference_grant',
      'run_revoked',
      'model_not_allowed',
      'tool_surface_mismatch',
      'run_not_active',
      'budget_exhausted',
      'inference_limit_exceeded',
    ]) {
      expect({ code, retryable: por[code]?.retryable }).toEqual({ code, retryable: false });
    }
    expect(por.admission_unavailable?.retryable).toBe(true);
    expect(por.provider_unavailable?.retryable).toBe(true);
    // 413 vira "compactar e tentar de novo" no cliente; a recusa acontece no
    // parse, antes da admissão, sem custo — e não é recusa de autoridade.
    expect(por.payload_too_large?.reason).toBe('payload_too_large');
  }, 60_000);
});
