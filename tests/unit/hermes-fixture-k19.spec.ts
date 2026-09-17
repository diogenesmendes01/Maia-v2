/**
 * C27 — os nomes de tool da fixture COMPARTILHADA do wire obedecem K-19.
 *
 * ─── A regra ──────────────────────────────────────────────────────────────
 *
 * K-19 (REQUIREMENTS-MATRIX) é a letra do §4.2 da spec, linha 323: "Default é
 * lista vazia; não permitir `maia_*`, `mcp:*`, `all` nem usar nomes inexistentes
 * como placeholders". A implementação é `classifyReservedToolName`
 * (src/integrations/hermes/manifest.ts), e este spec a USA em vez de redigitar
 * a regra — uma cópia aqui envelheceria em silêncio no dia em que a regra mudasse.
 *
 * ─── Por que a fixture e não só os testes ─────────────────────────────────
 *
 * `tests/fixtures/hermes-wire/frames.json` é lida pelos DOIS lados do
 * protocolo: pelo TS (`hermes-wire-contract.spec.ts`) e pelo Python
 * (`services/hermes_worker/tests/conftest.py`). Ela usava `maia_fixture_echo`
 * em sete posições — inclusive em `manifest.tools[].name` do frame `start`,
 * onde um manifest REAL do P05 recusaria o nome. Um primeiro run ponta a ponta
 * reprovaria por construção: o manifest não consegue emitir o nome que a
 * fixture espera, e o §6.6 exige igualdade exata entre manifest,
 * `effective_tool_names` e a superfície enviada ao provider.
 *
 * ─── O que este spec NÃO afrouxa ──────────────────────────────────────────
 *
 * Os casos NEGATIVOS do P05 continuam usando `maia_fixture_echo` como exemplo
 * de nome recusado (`hermes-manifest-contract.spec.ts`,
 * `hermes-tool-broker-policy.spec.ts`), e são a única exceção permitida à
 * varredura abaixo. Trocar o nome deles faria o caso de recusa aceitar.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { describe, it, expect } from 'vitest';
import {
  classifyReservedToolName,
  INITIAL_TOOL_DENY,
} from '@/integrations/hermes/manifest.js';

const RAIZ = resolve(__dirname, '../..');

type Frame = {
  type?: string;
  name?: string;
  effective_tool_names?: string[];
  manifest?: { tools?: Array<{ name?: string }> };
};
type Fixture = {
  cases: Array<{ id: string; frame?: Frame }>;
  raw_line_cases: Array<{ id: string; line: string }>;
};

const fixture = JSON.parse(
  readFileSync(join(RAIZ, 'tests/fixtures/hermes-wire/frames.json'), 'utf8'),
) as Fixture;

/** Cada nome de tool com a POSIÇÃO de onde veio — a mensagem de falha diz onde. */
function nomesDaFixture(): Array<{ onde: string; nome: string }> {
  const achados: Array<{ onde: string; nome: string }> = [];
  const doFrame = (onde: string, f: Frame | undefined): void => {
    if (!f) return;
    for (const nome of f.effective_tool_names ?? []) {
      achados.push({ onde: `${onde}.effective_tool_names`, nome });
    }
    if (f.type === 'tool.request' && typeof f.name === 'string') {
      achados.push({ onde: `${onde}.name`, nome: f.name });
    }
    for (const t of f.manifest?.tools ?? []) {
      if (typeof t.name === 'string') {
        achados.push({ onde: `${onde}.manifest.tools[].name`, nome: t.name });
      }
    }
  };
  for (const c of fixture.cases) doFrame(`cases[${c.id}]`, c.frame);
  for (const r of fixture.raw_line_cases) {
    // Linhas cruas podem ser JSON inválido de propósito — é o que elas testam.
    let frame: Frame | undefined;
    try {
      const v = JSON.parse(r.line) as unknown;
      if (v && typeof v === 'object' && !Array.isArray(v)) frame = v as Frame;
    } catch {
      frame = undefined;
    }
    doFrame(`raw_line_cases[${r.id}]`, frame);
  }
  return achados;
}

describe('C27 — nomes de tool da fixture compartilhada obedecem K-19', () => {
  it('a varredura NÃO é vácua: acha nome nas três posições que o protocolo carrega', () => {
    // Sem isto, um refactor da fixture que apagasse as posições deixaria o
    // caso seguinte verde sem ter olhado nome nenhum.
    const posicoes = new Set(nomesDaFixture().map(({ onde }) => onde.replace(/^[^\]]*\]\./, '')));
    expect(posicoes).toContain('effective_tool_names');
    expect(posicoes).toContain('name');
    expect(posicoes).toContain('manifest.tools[].name');
  });

  it('nenhum nome de tool da fixture é reservado por K-19 nem está no deny inicial', () => {
    const violacoes = nomesDaFixture()
      .map(({ onde, nome }) => ({
        onde,
        nome,
        k19: classifyReservedToolName(nome),
        deny: INITIAL_TOOL_DENY.has(nome),
      }))
      .filter((v) => v.k19 !== null || v.deny);
    expect(violacoes).toEqual([]);
  });

  it('o nome reservado antigo não sobrevive em harness de teste, fora dos casos NEGATIVOS do P05', () => {
    // Cobre o que a fixture não cobre: os literais dos testes Python e TS que
    // usam o nome da tool de fixture como nome VÁLIDO. Varredura por
    // diretório, para que arquivo novo também seja pego.
    const PERMITIDOS = new Set([
      'tests/unit/hermes-manifest-contract.spec.ts',
      'tests/unit/hermes-tool-broker-policy.spec.ts',
      'tests/unit/hermes-fixture-k19.spec.ts',
    ]);
    const IGNORAR_DIR = new Set(['node_modules', '__pycache__', '.pytest_cache', '.venv']);
    const encontrados: string[] = [];
    const varrer = (dir: string): void => {
      for (const nome of readdirSync(dir)) {
        if (IGNORAR_DIR.has(nome)) continue;
        const caminho = join(dir, nome);
        if (statSync(caminho).isDirectory()) {
          varrer(caminho);
          continue;
        }
        if (!/\.(ts|py|json)$/.test(nome)) continue;
        const rel = relative(RAIZ, caminho).split('\\').join('/');
        if (PERMITIDOS.has(rel)) continue;
        if (/maia_fixture/.test(readFileSync(caminho, 'utf8'))) encontrados.push(rel);
      }
    };
    varrer(join(RAIZ, 'tests'));
    varrer(join(RAIZ, 'services/hermes_worker/tests'));
    expect(encontrados).toEqual([]);
  });
});
